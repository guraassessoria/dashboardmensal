$ErrorActionPreference = 'Stop'

$expectedPackage = 'cbf-dashboard'
$expectedVercelProject = 'dashboardpaletacbf'

Write-Host ''
Write-Host '=== Environment Check ===' -ForegroundColor Cyan
Write-Host "Path: $((Get-Location).Path)"

$packageJson = Get-Content 'package.json' -Raw | ConvertFrom-Json
$packageName = $packageJson.name

$vercelProject = ''
if (Test-Path '.vercel/project.json') {
  $vercelJson = Get-Content '.vercel/project.json' -Raw | ConvertFrom-Json
  $vercelProject = $vercelJson.projectName
}

$gitRemotes = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
  $gitRemotes = (git remote -v) -join "`n"
}

Write-Host "Package name: $packageName"
Write-Host "Vercel project: $vercelProject"
Write-Host 'Git remotes:'
Write-Host $gitRemotes

$hasError = $false
if ($packageName -ne $expectedPackage) {
  Write-Host "ERROR: expected package '$expectedPackage'." -ForegroundColor Red
  $hasError = $true
}

if ($vercelProject -ne $expectedVercelProject) {
  Write-Host "ERROR: expected vercel project '$expectedVercelProject'." -ForegroundColor Red
  $hasError = $true
}

if ($hasError) {
  Write-Host 'Check failed. Stop before editing/deploying.' -ForegroundColor Red
  exit 1
}

Write-Host 'Check passed. You are in the correct project.' -ForegroundColor Green
