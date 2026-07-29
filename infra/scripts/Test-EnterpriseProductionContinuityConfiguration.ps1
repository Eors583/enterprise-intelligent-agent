[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseContinuityConfiguration.ps1')

$resolved = [System.IO.Path]::GetFullPath($Path)
$configuration = Get-Content -LiteralPath $resolved -Raw -Encoding utf8 | ConvertFrom-Json
$validation = Test-EnterpriseContinuityConfiguration -Configuration $configuration
[ordered]@{
  status = if ([bool]$validation.valid) { 'configuration-valid' } else { 'configuration-blocked' }
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  configurationPath = $resolved
  valid = [bool]$validation.valid
  blockers = @($validation.blockers)
  warnings = @($validation.warnings)
} | ConvertTo-Json -Depth 6

if (-not [bool]$validation.valid) { exit 2 }
