# Test dependency only. No ExifTool executable is bundled in the application.
$ErrorActionPreference = "Stop"
$Commit = "9b8664dfcf2c609d3cc8925d380e98ad2a379f9b" # Official ExifTool 13.61
$Install = Join-Path $env:RUNNER_TEMP "photofactory-exiftool"
$Source = Join-Path $Install "source"
New-Item -ItemType Directory -Path $Install -Force | Out-Null
# Git for Windows supplies Perl, including on the Windows ARM64 runner.
$GitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git).Source)
$Perl = Join-Path $GitRoot "usr\bin\perl.exe"
if (-not (Test-Path $Perl)) { throw "Git for Windows Perl was not found: $Perl" }
git clone --quiet --depth 1 --branch 13.61 https://github.com/exiftool/exiftool.git $Source
if ($LASTEXITCODE -ne 0) { throw "Official ExifTool source checkout failed" }
$ActualCommit = git -C $Source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $ActualCommit.Trim() -ne $Commit) {
    throw "Official ExifTool source commit mismatch"
}
$env:PHOTOFACTORY_EXIFTOOL_PERL = $Perl
$Tool = Join-Path $Install "exiftool.exe"
rustc scripts/exiftool-ci-launcher.rs -o $Tool
if ($LASTEXITCODE -ne 0) { throw "ExifTool test launcher compilation failed" }
Add-Content -Path $env:GITHUB_PATH -Value $Install
& $Tool -ver
if ($LASTEXITCODE -ne 0) { throw "ExifTool startup failed" }
