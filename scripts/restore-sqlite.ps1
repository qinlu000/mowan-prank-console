param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$Service = "app",
  [string]$DatabasePath = "/data/mowan.sqlite"
)

$ErrorActionPreference = "Stop"

$source = (Resolve-Path -LiteralPath $BackupPath).Path

docker compose stop $Service
if ($LASTEXITCODE -ne 0) {
  throw "Failed to stop $Service"
}

docker compose cp $source "${Service}:${DatabasePath}"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy $source into ${Service}:${DatabasePath}"
}

docker compose start $Service
if ($LASTEXITCODE -ne 0) {
  throw "Failed to start $Service"
}

Write-Host "SQLite database restored from $source"
