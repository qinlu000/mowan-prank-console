param(
  [string]$BackupDir = "backups",
  [string]$Service = "app",
  [string]$DatabasePath = "/data/mowan.sqlite"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $BackupDir "mowan-$timestamp.sqlite"

docker compose cp "${Service}:${DatabasePath}" $target
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy ${Service}:${DatabasePath}"
}

foreach ($suffix in @("-wal", "-shm")) {
  $sidecarTarget = "$target$suffix"
  docker compose cp "${Service}:${DatabasePath}${suffix}" $sidecarTarget 2>$null
  $global:LASTEXITCODE = 0
}

Write-Host "SQLite backup saved to $target"
