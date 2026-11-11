param(
    [switch]$SkipTests,
    [ValidateSet("", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
    [string]$Target = $env:TAURI_TARGET
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. See docs/BUILDING.md."
    }
}

function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

Require-Command "node"
Require-Command "npm"
Require-Command "cargo"
Require-Command "python"

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing locked frontend dependencies..."
    npm ci
    Assert-NativeSuccess "npm ci"
}

$VenvPython = Join-Path $ProjectDir "ai_worker\.venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating Windows AI build environment..."
    python -m venv (Join-Path $ProjectDir "ai_worker\.venv")
    Assert-NativeSuccess "Python virtual environment creation"
}

$WorkerPlatform = & $VenvPython -c "import sysconfig; print(sysconfig.get_platform())"
Assert-NativeSuccess "Python architecture check"
if ($WorkerPlatform.Trim() -ne "win-amd64") {
    throw "The bundled AI dependencies require x64 Python (also on Windows ARM64); detected $WorkerPlatform. Recreate ai_worker/.venv using Python x64."
}

Write-Host "Installing AI runtime and packager..."
# Both wheels write the same onnxruntime module. Clean legacy CPU wheels before installing DirectML.
& $VenvPython -m pip uninstall -y onnxruntime onnxruntime-gpu
Assert-NativeSuccess "Remove conflicting ONNX runtimes"
& $VenvPython -m pip install --disable-pip-version-check --force-reinstall --no-deps --only-binary=:all: "onnxruntime-directml>=1.18,<2"
Assert-NativeSuccess "DirectML installation"
& $VenvPython -m pip install --disable-pip-version-check --only-binary=:all: -r "ai_worker\requirements.txt"
Assert-NativeSuccess "AI dependency installation"
& $VenvPython -m pip install --disable-pip-version-check "pyinstaller>=6,<7"
Assert-NativeSuccess "PyInstaller installation"

Write-Host "Checking AI models..."
& $VenvPython "ai_worker\download_models.py"
Assert-NativeSuccess "AI model validation/download"

if (-not $SkipTests) {
    Write-Host "Running frontend tests..."
    npm test -- --run
    Assert-NativeSuccess "Frontend tests"
    Write-Host "Running Rust tests..."
    cargo test --locked --manifest-path "src-tauri\Cargo.toml" --lib
    Assert-NativeSuccess "Rust tests"
}

Write-Host "Building native Windows AI Worker..."
$env:PYINSTALLER_CONFIG_DIR = Join-Path $ProjectDir "ai_worker\.pyinstaller-windows"
& $VenvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --name "photofactory-ai" `
    --distpath "ai_worker\dist" `
    --workpath "ai_worker\build" `
    --specpath "ai_worker" `
    --hidden-import "face_detector" `
    --hidden-import "scene_classifier" `
    --hidden-import "semantic_classifier" `
    --hidden-import "face_clusterer" `
    --collect-all "pillow_heif" `
    --collect-all "tokenizers" `
    --collect-binaries "onnxruntime" `
    "ai_worker\server.py"
Assert-NativeSuccess "Windows AI Worker build"

$WorkerExe = Join-Path $ProjectDir "ai_worker\dist\photofactory-ai\photofactory-ai.exe"
if (-not (Test-Path $WorkerExe)) {
    throw "PyInstaller did not produce $WorkerExe"
}

& $WorkerExe --check-directml
Assert-NativeSuccess "Bundled DirectML provider check"

# ARM64 NSIS is supported by Tauri; avoid the x64-only WiX v3 toolchain.
$Bundles = if ($Target -eq "aarch64-pc-windows-msvc") { "nsis" } else { "msi,nsis" }
$BuildArgs = @("run", "tauri", "--", "build", "--bundles", $Bundles, "--config", "src-tauri/tauri.bundle-ai.conf.json")
if ($Target) { $BuildArgs += @("--target", $Target) }
$BuildArgs += @("--", "--locked")
Write-Host "Building Windows installers for $Target ($Bundles)..."
& npm @BuildArgs
Assert-NativeSuccess "Windows installer build"

$BundleDir = if ($Target) { "src-tauri\target\$Target\release\bundle" } else { "src-tauri\target\release\bundle" }
$Artifacts = Get-ChildItem $BundleDir -Recurse -File |
    Where-Object { $_.Extension -eq ".msi" -or $_.Name -like "*-setup.exe" }
if (-not $Artifacts) {
    throw "No Windows installer was produced."
}

Write-Host "Build complete:"
foreach ($Artifact in $Artifacts) {
    $Hash = Get-FileHash $Artifact.FullName -Algorithm SHA256
    Write-Host "  $($Artifact.FullName)"
    Write-Host "    SHA256 $($Hash.Hash)"
}

