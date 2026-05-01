# Build a Chrome Web Store–ready ZIP (manifest v3 root files + icons only).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$version = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).version
$zipName = "library-auto-renew-v$version.zip"
$zipPath = Join-Path $dist $zipName

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

$toZip = @(
  (Join-Path $root "manifest.json")
  (Join-Path $root "popup.html")
) + (
  Get-ChildItem -Path $root -Filter "*.js" -File | ForEach-Object { $_.FullName }
) + @(
  (Join-Path $root "icons")
)

Compress-Archive -LiteralPath $toZip -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "Created $zipPath"
