# Test dependency only. The application still treats ExifTool as optional.
$ErrorActionPreference = "Stop"
$Version = "13.61"
$ExpectedHash = "ab75b37515385a753aa60a58f68ffffe1ff81e43b319df9540978fb19e0580e5"
$Archive = Join-Path $env:RUNNER_TEMP "exiftool-$Version.zip"
$Install = Join-Path $env:RUNNER_TEMP "photofactory-exiftool"
# Official upstream distribution, linked by https://exiftool.org/.
Invoke-WebRequest -Uri "https://downloads.sourceforge.net/project/exiftool/exiftool-${Version}_64.zip" -OutFile $Archive -TimeoutSec 180
if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
    throw "ExifTool ZIP checksum mismatch"
}
Expand-Archive -Path $Archive -DestinationPath $Install -Force
$Exe = Get-ChildItem $Install -Recurse -Filter "exiftool(-k).exe" | Select-Object -First 1
if (-not $Exe) { throw "Official ExifTool executable not found" }
$Tool = Join-Path $Exe.DirectoryName "exiftool.exe"
Move-Item $Exe.FullName $Tool -Force
Add-Content -Path $env:GITHUB_PATH -Value $Exe.DirectoryName
& $Tool -ver
if ($LASTEXITCODE -ne 0) { throw "ExifTool startup failed" }
