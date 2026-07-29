$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseContinuityConfiguration.ps1')

function Assert-True {
  param([bool]$Value, [string]$Message)
  if (-not $Value) { throw $Message }
}

function New-ValidConfiguration {
  return [pscustomobject]@{
    contractVersion = 1
    environment = 'production'
    database = 'enterprise_agent'
    backup = [pscustomobject]@{
      schedule = '0 1 * * *'
      localRetentionDays = 14
      offsite = [pscustomobject]@{
        enabled = $true
        provider = 's3_compatible'
        destination = 's3://backup-bucket/enterprise-agent'
        region = 'secondary-region'
        separateFailureDomain = $true
        credentialReference = 'secret://enterprise-agent/backup-writer'
        encryption = [pscustomobject]@{
          mode = 'KMS_ENVELOPE'
          keyReference = 'kms://backup/key'
        }
        immutability = [pscustomobject]@{
          mode = 'OBJECT_LOCK_COMPLIANCE'
          retentionDays = 35
        }
      }
    }
    pitr = [pscustomobject]@{
      enabled = $true
      walArchiveEnabled = $true
      timelineHistoryEnabled = $true
      restoreCommandConfigured = $true
      recoveryWindowMinutes = 15
      retentionHours = 168
      credentialReference = 'secret://enterprise-agent/wal-writer'
    }
    drill = [pscustomobject]@{
      rpoObjectiveMinutes = 15
      rtoObjectiveMinutes = 240
      maxReportAgeHours = 168
      isolatedRestoreRequired = $true
    }
  }
}

$valid = Test-EnterpriseContinuityConfiguration -Configuration (New-ValidConfiguration)
Assert-True $valid.valid 'A production configuration with KMS, immutable offsite backup, and PITR must pass.'
Assert-True ($valid.warnings -contains 'CONFIGURATION_ONLY_REQUIRES_RUNTIME_EVIDENCE') 'The gate must not claim runtime evidence.'

$inlineSecret = New-ValidConfiguration
$inlineSecret.backup.offsite | Add-Member -NotePropertyName secretKey -NotePropertyValue 'plaintext-secret'
$inlineSecretResult = Test-EnterpriseContinuityConfiguration -Configuration $inlineSecret
Assert-True (-not $inlineSecretResult.valid) 'Inline credentials must fail closed.'
Assert-True ($inlineSecretResult.blockers -contains 'INLINE_CREDENTIAL_FORBIDDEN') 'Inline credential blocker missing.'

$weak = New-ValidConfiguration
$weak.pitr.recoveryWindowMinutes = 60
$weak.drill.rpoObjectiveMinutes = 60
$weak.drill.rtoObjectiveMinutes = 480
$weak.backup.offsite.separateFailureDomain = $false
$weakResult = Test-EnterpriseContinuityConfiguration -Configuration $weak
Assert-True (-not $weakResult.valid) 'Weak continuity objectives must be rejected.'
foreach ($expected in @(
  'OFFSITE_FAILURE_DOMAIN_NOT_SEPARATE',
  'PITR_RECOVERY_WINDOW_EXCEEDS_RPO',
  'RPO_OBJECTIVE_EXCEEDS_15_MINUTES',
  'RTO_OBJECTIVE_EXCEEDS_4_HOURS'
)) {
  Assert-True ($weakResult.blockers -contains $expected) "Expected blocker $expected was not emitted."
}

$disabled = New-ValidConfiguration
$disabled.backup.offsite.enabled = $false
$disabled.pitr.enabled = $false
$disabledResult = Test-EnterpriseContinuityConfiguration -Configuration $disabled
Assert-True (-not $disabledResult.valid) 'Disabled offsite backup and PITR must not pass production gate.'
Assert-True ($disabledResult.blockers -contains 'OFFSITE_BACKUP_NOT_ENABLED') 'Offsite blocker missing.'
Assert-True ($disabledResult.blockers -contains 'PITR_NOT_ENABLED') 'PITR blocker missing.'

$placeholder = New-ValidConfiguration
$placeholder.backup.offsite.region = 'replace-with-secondary-region'
$placeholderResult = Test-EnterpriseContinuityConfiguration -Configuration $placeholder
Assert-True (-not $placeholderResult.valid) 'Deployment placeholders must fail closed.'
Assert-True ($placeholderResult.blockers -contains 'PLACEHOLDER_VALUE_FORBIDDEN') 'Placeholder blocker missing.'

Write-Output 'Enterprise continuity configuration tests passed (18 assertions).'
