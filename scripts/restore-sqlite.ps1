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

$cleanupCommand = "mkdir -p `$(dirname '$DatabasePath') && rm -f '$DatabasePath' '$DatabasePath-wal' '$DatabasePath-shm'"
docker compose run --rm --no-deps --entrypoint sh $Service -c $cleanupCommand
if ($LASTEXITCODE -ne 0) {
  throw "Failed to clean old SQLite files for $Service"
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
