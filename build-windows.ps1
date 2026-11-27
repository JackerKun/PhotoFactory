param(
    [switch]$SkipTests,
    [ValidateSet("", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
    [string]$Target = $env:TAURI_TARGET,
    [ValidateSet("All", "NSIS")]
    [string]$Installer = "All",
    [string]$ReusePreparedFrom = $env:REMOTEAGENT_PROJECT_ROOT
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

function Install-PipPackage([string]$Python, [string]$Step, [string[]]$Arguments) {
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        & $Python -m pip install --disable-pip-version-check --timeout 120 --retries 5 @Arguments
        if ($LASTEXITCODE -eq 0) { return }
        if ($Attempt -lt 3) {
            Write-Warning "$Step failed on attempt $Attempt of 3. Retrying."
            Start-Sleep -Seconds (5 * $Attempt)
        }
    }
    Assert-NativeSuccess $Step
}

function Initialize-X64BuildTools {
    if ($Target -ne "x86_64-pc-windows-msvc" -or ($env:VCToolsInstallDir -and $env:WindowsSdkDir)) { return }
    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { return }
    $Install = & $VsWhere -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath
    if (-not $Install) { return }
    $DevShell = Join-Path $Install "Common7\Tools\Launch-VsDevShell.ps1"
    if (Test-Path -LiteralPath $DevShell -PathType Leaf) {
        & $DevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
    }
}

function Copy-PreparedWorker([string]$SourceRoot, [string]$DestinationRoot) {
    if (-not $SourceRoot -or -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { return $false }
    $SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath

    $WorkerFolder = Join-Path $SourceRoot "ai_worker\dist\photofactory-ai"
    $PreparedExe = Join-Path $WorkerFolder "photofactory-ai.exe"
    if (-not (Test-Path -LiteralPath $PreparedExe -PathType Leaf)) { return $false }
    $BuiltAt = (Get-Item -LiteralPath $PreparedExe).LastWriteTimeUtc

    $DestinationAI = Join-Path $DestinationRoot "ai_worker"
    $SourceAI = Join-Path $SourceRoot "ai_worker"
    $BuildInputs = Get-ChildItem -LiteralPath $DestinationAI -File |
        Where-Object { $_.Name -eq "requirements.txt" -or ($_.Extension -eq ".py" -and $_.Name -notlike "test_*") }
    $PreparedInputs = Get-ChildItem -LiteralPath $SourceAI -File |
        Where-Object { $_.Name -eq "requirements.txt" -or ($_.Extension -eq ".py" -and $_.Name -notlike "test_*") }
    if (@($BuildInputs).Count -ne @($PreparedInputs).Count) { return $false }
    foreach ($InputFile in $BuildInputs) {
        $Original = Join-Path $SourceAI $InputFile.Name
        if (-not (Test-Path -LiteralPath $Original -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $Original).LastWriteTimeUtc -gt $BuiltAt -or
            (Get-FileHash -LiteralPath $Original).Hash -ne (Get-FileHash -LiteralPath $InputFile.FullName).Hash) {
            return $false
        }
    }

    $ModelNames = @("retinaface.onnx", "arcface.onnx", "resnet50_places365.onnx", "clip_vision_int8.onnx", "clip_text_int8.onnx", "clip_tokenizer.json")
    $PreparedModels = Join-Path $SourceAI "models"
    foreach ($Model in $ModelNames) {
        $File = Join-Path $PreparedModels $Model
        if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or (Get-Item -LiteralPath $File).Length -eq 0) { return $false }
    }

    & $PreparedExe --check-directml | Out-Host
    if ($LASTEXITCODE -ne 0) { return $false }

    if ($SourceRoot -eq $DestinationRoot) {
        Write-Host "Reused the prepared AI Worker and models in $SourceRoot"
        return $true
    }

    $DestinationWorker = Join-Path $DestinationAI "dist\photofactory-ai"
    $DestinationModels = Join-Path $DestinationAI "models"
    New-Item -ItemType Directory -Force -Path $DestinationWorker, $DestinationModels | Out-Null
    Copy-Item -Path (Join-Path $WorkerFolder "*") -Destination $DestinationWorker -Recurse -Force
    foreach ($Model in $ModelNames) {
        Copy-Item -LiteralPath (Join-Path $PreparedModels $Model) -Destination $DestinationModels -Force
    }

    $PreparedExifTool = Join-Path $SourceRoot "build\exiftool"
    if (Test-Path -LiteralPath (Join-Path $PreparedExifTool ".archive-sha256") -PathType Leaf) {
        $DestinationExifTool = Join-Path $DestinationRoot "build\exiftool"
        New-Item -ItemType Directory -Force -Path $DestinationExifTool | Out-Null
        Get-ChildItem -LiteralPath $PreparedExifTool -Force | Copy-Item -Destination $DestinationExifTool -Recurse -Force
    }
    Write-Host "Reused the prepared AI Worker and models from $SourceRoot"
    return $true
}

Require-Command "node"
Require-Command "npm"
Require-Command "cargo"
Require-Command "python"
Initialize-X64BuildTools

$FrontendStamp = Join-Path $ProjectDir "node_modules\.photofactory-dependencies"
$FrontendSignature = (Get-FileHash -LiteralPath "package.json", "package-lock.json").Hash -join ":"
$InstalledSignature = if (Test-Path -LiteralPath $FrontendStamp -PathType Leaf) { Get-Content -LiteralPath $FrontendStamp -Raw }
if ($FrontendSignature -ne $InstalledSignature) {
    Write-Host "Installing locked frontend dependencies..."
    npm ci --prefer-offline
    Assert-NativeSuccess "npm ci"
    Set-Content -LiteralPath $FrontendStamp -Value $FrontendSignature -NoNewline
}

$ReuseWorker = $false
try {
    $ReuseWorker = Copy-PreparedWorker $ReusePreparedFrom $ProjectDir
} catch {
    Write-Warning "Could not reuse prepared AI files. Building the AI Worker again. $($_.Exception.Message)"
}
if (-not $ReuseWorker) {
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
    Install-PipPackage $VenvPython "DirectML installation" @("--force-reinstall", "--no-deps", "--only-binary=:all:", "onnxruntime-directml>=1.18,<2")
    Install-PipPackage $VenvPython "AI dependency installation" @("--only-binary=:all:", "-r", "ai_worker\requirements.txt")
    Install-PipPackage $VenvPython "PyInstaller installation" @("pyinstaller>=6,<7")
}

python scripts/prepare-exiftool.py windows
Assert-NativeSuccess "ExifTool packaging"
$env:Path = "$(Join-Path $ProjectDir 'build\exiftool');$env:Path"

if (-not $ReuseWorker) {
    Write-Host "Checking AI models..."
    & $VenvPython "ai_worker\download_models.py"
    Assert-NativeSuccess "AI model validation/download"
}

if (-not $SkipTests) {
    Write-Host "Running frontend tests..."
    npm test -- --run
    Assert-NativeSuccess "Frontend tests"
    Write-Host "Running Rust tests..."
    cargo test --locked --manifest-path "src-tauri\Cargo.toml" --lib
    Assert-NativeSuccess "Rust tests"
}

if (-not $ReuseWorker) {
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
}

$WorkerExe = Join-Path $ProjectDir "ai_worker\dist\photofactory-ai\photofactory-ai.exe"
if (-not (Test-Path $WorkerExe)) {
    throw "PyInstaller did not produce $WorkerExe"
}

& $WorkerExe --check-directml
Assert-NativeSuccess "Bundled DirectML provider check"

# ARM64 NSIS is supported by Tauri; avoid the x64-only WiX v3 toolchain.
$Bundles = if ($Installer -eq "NSIS" -or $Target -eq "aarch64-pc-windows-msvc") { "nsis" } else { "msi,nsis" }
$BuildArgs = @("run", "tauri", "--", "build", "--bundles", $Bundles, "--config", "src-tauri/tauri.bundle-ai.conf.json")
if ($Target) { $BuildArgs += @("--target", $Target) }
$BuildArgs += @("--", "--locked")
Write-Host "Building Windows installers for $Target ($Bundles)..."
& npm @BuildArgs
Assert-NativeSuccess "Windows installer build"

$BundleDir = if ($Target) { "src-tauri\target\$Target\release\bundle" } else { "src-tauri\target\release\bundle" }
$Artifacts = Get-ChildItem $BundleDir -Recurse -File |
    Where-Object { $_.Name -like "*-setup.exe" -or ($Bundles -eq "msi,nsis" -and $_.Extension -eq ".msi") }
if (-not $Artifacts) {
    throw "No Windows installer was produced."
}

Write-Host "Build complete:"
foreach ($Artifact in $Artifacts) {
    $Hash = Get-FileHash $Artifact.FullName -Algorithm SHA256
    Write-Host "  $($Artifact.FullName)"
    Write-Host "    SHA256 $($Hash.Hash)"
}

