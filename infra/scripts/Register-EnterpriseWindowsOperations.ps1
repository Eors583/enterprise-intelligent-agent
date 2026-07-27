[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$SourceContainer,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$SourceDatabase,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$SourceDatabaseUser,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$RestoreContainer,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$RestoreDatabaseUser,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')]
  [string]$ExpectedEmbeddingModel,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://[^\s]+$')]
  [string]$ApiBaseUrl,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://[^\s]+$')]
  [string]$AdminBaseUrl,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://[^\s]+$')]
  [string]$AiRuntimeBaseUrl,

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$')]
  [string]$TaskNamePrefix = 'EnterpriseAgent',

  [ValidateRange(1, 60)]
  [int]$MonitoringIntervalMinutes = 5,

  [ValidateRange(0, 23)]
  [int]$DailyBackupHour = 2,

  [ValidateRange(0, 23)]
  [int]$WeeklyRestoreHour = 3,

  [ValidateSet('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')]
  [string]$WeeklyRestoreDay = 'Sunday',

  [string]$BackupDirectory = '',

  [switch]$SkipAlertDelivery
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseScheduledTaskCommand.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'This installer targets Windows Task Scheduler. Use the same one-shot scripts from cron or a Kubernetes CronJob on other platforms.'
}
if ($SourceContainer -eq $RestoreContainer) {
  throw 'Production restore rehearsals require a PostgreSQL container isolated from the backup source.'
}
if ($DailyBackupHour -eq $WeeklyRestoreHour) {
  throw 'Daily backup and weekly restore rehearsal must not be scheduled for the same hour.'
}
if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $BackupDirectory = Join-Path $PSScriptRoot '..\..\.data\backups'
}
if (-not $SkipAlertDelivery) {
  $machineWebhook = [Environment]::GetEnvironmentVariable(
    'ENTERPRISE_ALERT_WEBHOOK_URL',
    [EnvironmentVariableTarget]::Machine
  )
  if ([string]::IsNullOrWhiteSpace($machineWebhook)) {
    throw 'Set the machine-scoped ENTERPRISE_ALERT_WEBHOOK_URL before registering unattended monitoring, or explicitly use -SkipAlertDelivery for a non-production rehearsal.'
  }
}

Import-Module ScheduledTasks -ErrorAction Stop

function New-ScriptAction {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string[]]$RequiredSwitches
  )

  $argumentLine = New-EnterprisePowerShellTaskArgumentLine -ScriptPath $Script -Arguments $Arguments
  Assert-EnterpriseTaskArgumentLine -ArgumentLine $argumentLine -RequiredSwitches $RequiredSwitches
  $action = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument $argumentLine `
    -WorkingDirectory (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  if ([string]$action.Arguments -ne $argumentLine) {
    throw 'Windows Task Scheduler changed the generated PowerShell argument line.'
  }
  return $action
}

$commonSettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

$backupDirectoryPath = Resolve-EnterpriseBackupStoragePath -Path $BackupDirectory
if ($PSCmdlet.ShouldProcess($backupDirectoryPath, 'Initialize dedicated backup storage and restrict permissions')) {
  $backupDirectoryPath = Initialize-EnterpriseBackupStorage -Path $backupDirectoryPath -AllowInitialize
}
if (-not $WhatIfPreference) {
  # If initialization was declined, do not register tasks that are guaranteed to
  # fail or that could later claim an unrelated directory unattended.
  $backupDirectoryPath = Initialize-EnterpriseBackupStorage -Path $backupDirectoryPath
}
$backupAction = New-ScriptAction -Script (Join-Path $PSScriptRoot 'Backup-EnterpriseDatabase.ps1') -Arguments @(
  '-Container', (Quote-EnterpriseTaskArgument $SourceContainer),
  '-Database', (Quote-EnterpriseTaskArgument $SourceDatabase),
  '-DatabaseUser', (Quote-EnterpriseTaskArgument $SourceDatabaseUser),
  '-OutputDirectory', (Quote-EnterpriseTaskArgument $backupDirectoryPath)
) -RequiredSwitches @('-Container', '-Database', '-DatabaseUser', '-OutputDirectory')
$backupTrigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours($DailyBackupHour))

$restoreAction = New-ScriptAction -Script (Join-Path $PSScriptRoot 'Invoke-EnterpriseBackupRehearsal.ps1') -Arguments @(
  '-SourceContainer', (Quote-EnterpriseTaskArgument $SourceContainer),
  '-SourceDatabase', (Quote-EnterpriseTaskArgument $SourceDatabase),
  '-SourceDatabaseUser', (Quote-EnterpriseTaskArgument $SourceDatabaseUser),
  '-RestoreContainer', (Quote-EnterpriseTaskArgument $RestoreContainer),
  '-RestoreDatabaseUser', (Quote-EnterpriseTaskArgument $RestoreDatabaseUser),
  '-BackupDirectory', (Quote-EnterpriseTaskArgument $backupDirectoryPath)
) -RequiredSwitches @('-SourceContainer', '-SourceDatabase', '-SourceDatabaseUser', '-RestoreContainer', '-RestoreDatabaseUser', '-BackupDirectory')
$restoreTrigger = New-ScheduledTaskTrigger `
  -Weekly `
  -WeeksInterval 1 `
  -DaysOfWeek $WeeklyRestoreDay `
  -At ([DateTime]::Today.AddHours($WeeklyRestoreHour))

$monitoringArguments = @(
  '-Container', (Quote-EnterpriseTaskArgument $SourceContainer),
  '-Database', (Quote-EnterpriseTaskArgument $SourceDatabase),
  '-DatabaseUser', (Quote-EnterpriseTaskArgument $SourceDatabaseUser),
  '-ExpectedEmbeddingModel', (Quote-EnterpriseTaskArgument $ExpectedEmbeddingModel),
  '-BackupDirectory', (Quote-EnterpriseTaskArgument $backupDirectoryPath),
  '-ApiBaseUrl', (Quote-EnterpriseTaskArgument $ApiBaseUrl),
  '-AdminBaseUrl', (Quote-EnterpriseTaskArgument $AdminBaseUrl),
  '-AiRuntimeBaseUrl', (Quote-EnterpriseTaskArgument $AiRuntimeBaseUrl)
)
if (-not $SkipAlertDelivery) { $monitoringArguments += '-Deliver' }
$monitoringAction = New-ScriptAction `
  -Script (Join-Path $PSScriptRoot 'Invoke-EnterpriseMonitoringCycle.ps1') `
  -Arguments $monitoringArguments `
  -RequiredSwitches @('-Container', '-Database', '-DatabaseUser', '-ExpectedEmbeddingModel', '-BackupDirectory', '-ApiBaseUrl', '-AdminBaseUrl', '-AiRuntimeBaseUrl')
$monitoringTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $MonitoringIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$definitions = @(
  [ordered]@{ Name = "$TaskNamePrefix-Backup"; Action = $backupAction; Trigger = $backupTrigger },
  [ordered]@{ Name = "$TaskNamePrefix-RestoreRehearsal"; Action = $restoreAction; Trigger = $restoreTrigger },
  [ordered]@{ Name = "$TaskNamePrefix-Monitoring"; Action = $monitoringAction; Trigger = $monitoringTrigger }
)

foreach ($definition in $definitions) {
  if ($PSCmdlet.ShouldProcess($definition.Name, 'Register or replace Windows scheduled task')) {
    Register-ScheduledTask `
      -TaskName $definition.Name `
      -Action $definition.Action `
      -Trigger $definition.Trigger `
      -Settings $commonSettings `
      -Principal $principal `
      -Description 'Enterprise Agent unattended operations; managed from the repository deployment baseline.' `
      -Force | Out-Null
  }
}

[ordered]@{
  status = if ($WhatIfPreference) { 'validated-what-if' } else { 'registered' }
  taskNames = @($definitions | ForEach-Object { $_.Name })
  runAs = 'SYSTEM'
  alertDelivery = -not $SkipAlertDelivery
  expectedEmbeddingModel = $ExpectedEmbeddingModel
} | ConvertTo-Json -Depth 4
