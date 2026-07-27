[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$Path = (Join-Path $PSScriptRoot '..\..\.data\backups')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')

$resolved = Resolve-EnterpriseBackupStoragePath -Path $Path
if ($PSCmdlet.ShouldProcess($resolved, 'Claim as dedicated backup storage and restrict its permissions')) {
  $resolved = Initialize-EnterpriseBackupStorage -Path $resolved -AllowInitialize
}

[ordered]@{
  status = if ($WhatIfPreference) { 'validated-what-if' } else { 'initialized' }
  path = $resolved
} | ConvertTo-Json
