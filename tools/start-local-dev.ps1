[CmdletBinding()]
param(
  [switch]$InfrastructureOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $workspace '.env'

function Read-DotEnvValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Test-Path -LiteralPath $envFile)) {
    return $null
  }
  $prefix = "$Name="
  $line = Get-Content -LiteralPath $envFile -Encoding utf8 |
    Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } |
    Select-Object -Last 1
  if ($null -eq $line) {
    return $null
  }
  return $line.Substring($prefix.Length).Trim()
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n==> $Label" -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Uses-PgvectorDevelopmentDatabase {
  $databaseUrl = Read-DotEnvValue -Name 'DATABASE_URL'
  if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    return $false
  }
  try {
    $uri = [Uri]$databaseUrl
    return $uri.Host -in @('127.0.0.1', 'localhost') -and $uri.Port -eq 55433
  } catch {
    throw 'DATABASE_URL in .env is not a valid PostgreSQL URL.'
  }
}

$docker = (Get-Command docker -ErrorAction Stop).Source
$pnpm = (Get-Command pnpm -ErrorAction Stop).Source

Push-Location $workspace
try {
  Write-Host "`n==> Checking Docker Desktop" -ForegroundColor Cyan
  $dockerServerVersion = & $docker 'version' '--format' '{{.Server.Version}}'
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerServerVersion)) {
    throw 'Docker Desktop is not running.'
  }
  Write-Host "Docker Engine $dockerServerVersion is available."

  if (Uses-PgvectorDevelopmentDatabase) {
    Invoke-Checked -Label 'Starting pgvector PostgreSQL' -Command $docker -Arguments @(
      'compose', '-f', 'infra/docker-compose.pgvector.dev.yml',
      'up', '-d', '--wait', '--wait-timeout', '180'
    )
    Invoke-Checked -Label 'Starting Redis' -Command $docker -Arguments @(
      'compose', '-f', 'infra/docker-compose.dev.yml',
      'up', '-d', '--wait', '--wait-timeout', '180', 'redis'
    )
  } else {
    Invoke-Checked -Label 'Starting PostgreSQL and Redis' -Command $docker -Arguments @(
      'compose', '-f', 'infra/docker-compose.dev.yml',
      'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis'
    )
  }

  if ((Read-DotEnvValue -Name 'KNOWLEDGE_LOCAL_BACKEND_ENABLED') -ne 'false') {
    Invoke-Checked -Label 'Starting knowledge storage, search, parser, and scanner' -Command $docker -Arguments @(
      'compose', '-f', 'infra/docker-compose.knowledge.dev.yml',
      'up', '-d', '--wait', '--wait-timeout', '900', 'minio', 'qdrant', 'docling', 'tika', 'clamav'
    )
    Invoke-Checked -Label 'Ensuring the private knowledge bucket exists' -Command $docker -Arguments @(
      'compose', '-f', 'infra/docker-compose.knowledge.dev.yml',
      'run', '--rm', 'minio-init'
    )
  } else {
    Write-Host "Local knowledge infrastructure is disabled; skipping it."
  }

  if ($InfrastructureOnly) {
    Write-Host "`nInfrastructure is ready." -ForegroundColor Green
    return
  }

  Write-Host "`nInfrastructure is ready. Starting API, AI Runtime, admin, and desktop..." -ForegroundColor Green
  Invoke-Checked -Label 'Starting application services' -Command $pnpm -Arguments @('dev')
} finally {
  Pop-Location
}
