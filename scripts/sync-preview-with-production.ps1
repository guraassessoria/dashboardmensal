param(
  [string]$BaseUrl = "https://dashboardpaletacbf.vercel.app"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $root "public"
$imagesDir = Join-Path $publicDir "assets\imagens"

if (!(Test-Path $imagesDir)) {
  New-Item -ItemType Directory -Path $imagesDir -Force | Out-Null
}

$tmpHtml = Join-Path $env:TEMP "dashboard_prod_sync.html"
$prodHtmlUrl = "$BaseUrl/dashboard.html"

Write-Output "Downloading: $prodHtmlUrl"
Invoke-WebRequest -Uri $prodHtmlUrl -OutFile $tmpHtml

# Sync both local preview files with current production HTML
Copy-Item $tmpHtml (Join-Path $publicDir "dashboard.html") -Force
Copy-Item $tmpHtml (Join-Path $publicDir "dashboard-dev.html") -Force

# Sync known production assets used by dashboard.html
$assetFiles = @(
  "bola-brasileirao-2025.jpg",
  "CBF_Logo_Transparente.png"
)

foreach ($asset in $assetFiles) {
  $assetUrl = "$BaseUrl/assets/imagens/$asset"
  $assetPath = Join-Path $imagesDir $asset
  Write-Output "Downloading: $assetUrl"
  Invoke-WebRequest -Uri $assetUrl -OutFile $assetPath
}

$prodHash = (Get-FileHash $tmpHtml).Hash
$dashHash = (Get-FileHash (Join-Path $publicDir "dashboard.html")).Hash
$devHash = (Get-FileHash (Join-Path $publicDir "dashboard-dev.html")).Hash

Write-Output "PROD_HASH: $prodHash"
Write-Output "LOCAL_DASH_HASH: $dashHash"
Write-Output "LOCAL_DEV_HASH: $devHash"
Write-Output "DASH_MATCH: $($prodHash -eq $dashHash)"
Write-Output "DEV_MATCH: $($prodHash -eq $devHash)"

Write-Output "Assets in public/assets/imagens:"
Get-ChildItem $imagesDir | Select-Object Name, Length
