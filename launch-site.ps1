param(
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$tokenFile = Join-Path $PSScriptRoot "mapbox-token.txt"
$configFile = Join-Path $PSScriptRoot "dist\config.js"
$siteDirectory = Join-Path $PSScriptRoot "dist"

if (-not (Test-Path -LiteralPath $tokenFile)) {
  Set-Content -LiteralPath $tokenFile -Value "PASTE_YOUR_MAPBOX_PUBLIC_TOKEN_HERE" -Encoding utf8
}

$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if (-not $token.StartsWith("pk.") -or $token.Contains("YOUR_MAPBOX")) {
  Write-Host "Mapbox token is not configured yet." -ForegroundColor Yellow
  Write-Host "Paste your public pk. token into mapbox-token.txt, save it, then double-click Launch Site.cmd again."
  Start-Process notepad.exe -ArgumentList $tokenFile
  exit 1
}

if (-not (Test-Path -LiteralPath $siteDirectory)) {
  throw "The dist folder was not found."
}

$tokenJson = $token | ConvertTo-Json -Compress
$config = @"
// Generated locally by Launch Site.cmd from mapbox-token.txt.
window.MAP_CONFIG = {
  accessToken: $tokenJson,
  style: "mapbox://styles/mapbox/standard"
};
"@
Set-Content -LiteralPath $configFile -Value $config -Encoding utf8

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  throw "Python was not found. Install Python or run another local web server for the dist folder."
}

$url = "http://localhost:$Port"
Write-Host "Starting Singapore Site Similarity Explorer" -ForegroundColor Cyan
Write-Host "URL: $url"
Write-Host "Keep this window open. Press Ctrl+C to stop the site."

Start-Job -ScriptBlock {
  param($Address)
  Start-Sleep -Seconds 1
  Start-Process $Address
} -ArgumentList $url | Out-Null

& $python.Source -m http.server $Port --directory $siteDirectory
