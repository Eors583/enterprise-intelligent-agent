function Resolve-EnterpriseRestoreReportStatus {
  [CmdletBinding()]
  param(
    [bool]$CleanupVerified,
    [bool]$OperationFailed,
    [ValidateRange(0, [int]::MaxValue)][int]$FailedCheckCount
  )

  if (-not $CleanupVerified) { return 'restore-cleanup-failed' }
  if ($OperationFailed) { return 'restore-operation-failed' }
  if ($FailedCheckCount -gt 0) { return 'restore-verification-failed' }
  return 'restore-verified'
}
