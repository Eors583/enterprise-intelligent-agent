$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseScheduledTaskCommand.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

$scriptPath = Join-Path $PSScriptRoot 'Test-EnterpriseCoreAlertStatus.ps1'
$line = New-EnterprisePowerShellTaskArgumentLine -ScriptPath $scriptPath -Arguments @(
  '-Container', (Quote-EnterpriseTaskArgument 'sample-container'),
  '-Database', (Quote-EnterpriseTaskArgument 'sample_database'),
  '-Deliver'
)
Assert-EnterpriseTaskArgumentLine -ArgumentLine $line -RequiredSwitches @('-Container', '-Database', '-Deliver')
Assert-True (-not $line.Contains('System.Object[]')) 'The argument array must be flattened.'
Assert-True ($line.Contains('-Container "sample-container"')) 'The container value must remain quoted.'
Assert-True ($line.Contains('-Database "sample_database"')) 'The database value must remain quoted.'

$missingRejected = $false
try {
  Assert-EnterpriseTaskArgumentLine -ArgumentLine $line -RequiredSwitches @('-ExpectedEmbeddingModel')
}
catch {
  $missingRejected = $true
}
Assert-True $missingRejected 'The WhatIf self-check must reject a missing required switch.'

[ordered]@{ status = 'passed'; tests = 5 } | ConvertTo-Json
