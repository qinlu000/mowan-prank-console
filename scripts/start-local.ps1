param(
  [string]$AdminPassword = "change-this-admin-password",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5173
)

$env:ADMIN_PASSWORD = $AdminPassword
$env:HOST = $HostName
$env:PORT = [string]$Port

npm start
