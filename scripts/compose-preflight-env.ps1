# Refuse to run Compose with environment variables that override compose.env.
# This script only reads the current process environment; it never prints or
# modifies variable values and never invokes Docker.

$ErrorActionPreference = 'Stop'

$composeVariables = @(
  'DATABASE_URL',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'JWT_SECRET',
  'INTERNAL_SECRET',
  'VNPAY_TMN_CODE',
  'VNPAY_HASH_SECRET',
  'VNPAY_PAYMENT_URL',
  'VNPAY_RETURN_URL',
  'VNPAY_QUERYDR_URL',
  'VNPAY_QUERYDR_TIMEOUT_MS',
  'COMPOSE_PROJECT_NAME'
)

$conflicts = @()
foreach ($name in $composeVariables) {
  if (Test-Path "Env:\$name") {
    $conflicts += $name
  }
}

if ($conflicts.Count -gt 0) {
  [Console]::Error.WriteLine('Compose preflight failed: environment variable(s) in this session would override compose.env:')
  foreach ($name in $conflicts) {
    [Console]::Error.WriteLine("  - $name")
  }
  $removeCmd = ($conflicts | ForEach-Object { "Remove-Item Env:\$_ -ErrorAction SilentlyContinue" }) -join '; '
  [Console]::Error.WriteLine('')
  [Console]::Error.WriteLine('Remove the listed variable(s) in this PowerShell session, then rerun:')
  [Console]::Error.WriteLine("  $removeCmd")
  [Console]::Error.WriteLine('')
  [Console]::Error.WriteLine('The preflight does not print or modify variable values.')
  exit 1
}

Write-Output 'Compose preflight passed: no conflicting environment variables detected.'
exit 0
