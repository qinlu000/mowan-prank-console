param(
  [string]$BackupDir = "backups",
  [string]$Service = "app",
  [string]$DatabasePath = "/data/mowan.sqlite"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "mowan-$timestamp.sqlite"
$target = Join-Path $BackupDir $fileName
$containerTarget = "/data/backups/$fileName"

docker compose exec -T $Service node scripts/sqlite-backup.js $DatabasePath $containerTarget
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create SQLite backup inside $Service"
}

docker compose cp "${Service}:${containerTarget}" $target
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy ${Service}:${containerTarget}"
}

docker compose exec -T $Service rm -f $containerTarget 2>$null
$global:LASTEXITCODE = 0

Write-Host "SQLite backup saved to $target"
