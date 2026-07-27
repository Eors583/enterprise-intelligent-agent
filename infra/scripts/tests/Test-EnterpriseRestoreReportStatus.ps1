$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseRestoreReportStatus.ps1')

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', received '$Actual'." }
}

Assert-Equal (Resolve-EnterpriseRestoreReportStatus -CleanupVerified $false -OperationFailed $false -FailedCheckCount 0) 'restore-cleanup-failed' 'Cleanup must gate success.'
Assert-Equal (Resolve-EnterpriseRestoreReportStatus -CleanupVerified $true -OperationFailed $true -FailedCheckCount 0) 'restore-operation-failed' 'Operation failure must survive cleanup.'
Assert-Equal (Resolve-EnterpriseRestoreReportStatus -CleanupVerified $true -OperationFailed $false -FailedCheckCount 1) 'restore-verification-failed' 'Failed checks must gate success.'
Assert-Equal (Resolve-EnterpriseRestoreReportStatus -CleanupVerified $true -OperationFailed $false -FailedCheckCount 0) 'restore-verified' 'Only cleanup plus checks may publish success.'

$restoreScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\Test-EnterpriseDatabaseRestore.ps1') -Raw -Encoding utf8
$cleanupPosition = $restoreScript.IndexOf('$cleanupVerified =')
$publishPosition = $restoreScript.IndexOf('Write-EnterpriseProtectedJsonAtomically -Path $reportPath')
if ($cleanupPosition -lt 0 -or $publishPosition -le $cleanupPosition) {
  throw 'The restore report must be published after cleanup is evaluated.'
}

[ordered]@{ status = 'passed'; tests = 5 } | ConvertTo-Json
