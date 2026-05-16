# regen-certs.ps1 — rotate the dev TLS keypair (cert.pem / key.pem).
#
# Usage (from project root):
#   pwsh ./regen-certs.ps1
#   # or in an existing PowerShell session:
#   .\regen-certs.ps1
#
# The previous key was committed to git history and must be treated as
# compromised. This script generates a fresh keypair and backs up the
# existing files (in case they were already rotated manually).

$ErrorActionPreference = 'Stop'

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    Write-Host "openssl not found in PATH." -ForegroundColor Red
    Write-Host "It ships with Git for Windows (try 'C:\Program Files\Git\usr\bin')," -ForegroundColor Yellow
    Write-Host "or install via: winget install ShiningLight.OpenSSL.Light" -ForegroundColor Yellow
    exit 1
}

$root    = $PSScriptRoot
$cert    = Join-Path $root 'cert.pem'
$key     = Join-Path $root 'key.pem'

if (Test-Path $cert -PathType Leaf) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $cert "$cert.bak.$stamp"
    if (Test-Path $key -PathType Leaf) { Copy-Item $key "$key.bak.$stamp" }
    Write-Host "Backed up existing pair as *.bak.$stamp" -ForegroundColor DarkGray
}

Write-Host "Generating new RSA-4096 self-signed cert (365 days, CN=localhost)..." -ForegroundColor Cyan
& openssl req -x509 -newkey rsa:4096 `
    -keyout $key `
    -out    $cert `
    -days   365 -nodes `
    -subj   "/CN=localhost"

if ($LASTEXITCODE -ne 0) {
    Write-Host "openssl failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "New cert.pem and key.pem generated." -ForegroundColor Green
Write-Host "Restart uvicorn to pick them up:" -ForegroundColor Green
Write-Host "  uvicorn backend.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem" -ForegroundColor Gray
Write-Host ""
Write-Host "Reminder: the OLD key remains in git history and must be considered compromised." -ForegroundColor Yellow
Write-Host "If you want it scrubbed from history too, ask me to do the (destructive) 'git filter-repo' rewrite." -ForegroundColor Yellow
