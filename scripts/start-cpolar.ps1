param(
  [string]$AuthToken,
  [int]$Port = 5173,
  [string]$Region = "cn",
  [string]$CpolarPath = "C:\tmp\cpolar-portable\cpolar.exe"
)

if (!(Test-Path -LiteralPath $CpolarPath)) {
  Write-Error "cpolar.exe not found at $CpolarPath"
  exit 1
}

if ($AuthToken) {
  & $CpolarPath authtoken $AuthToken
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

& $CpolarPath http -region=$Region -log=stdout $Port
