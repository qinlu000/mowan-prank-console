param(
  [string]$AdminUsername = "admin",
  [string]$AdminPassword = "change-this-admin-password",
  [string]$AdminUsers = "",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5173
)

$env:ADMIN_USERNAME = $AdminUsername
$env:ADMIN_PASSWORD = $AdminPassword
if ($AdminUsers) {
  $env:ADMIN_USERS = $AdminUsers
}
$env:HOST = $HostName
$env:PORT = [string]$Port

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) {
  & $pnpm.Source start
  exit $LASTEXITCODE
}

$voltaPnpm = Join-Path $env:ProgramFiles "Volta\pnpm.exe"
if (Test-Path -LiteralPath $voltaPnpm) {
  & $voltaPnpm start
  exit $LASTEXITCODE
}

Write-Error "pnpm was not found. Install Volta, then run: volta install node@22.19.0 pnpm@11.2.2"
exit 1
