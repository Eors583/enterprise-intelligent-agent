[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
  [string]$Container,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$Database,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
  [string]$DatabaseUser,

  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')]
  [string]$ExpectedEmbeddingModel = '',

  [string]$BackupDirectory = '',

  [ValidatePattern('^https?://[^\s]+$')]
  [string]$ApiBaseUrl = 'http://127.0.0.1:3000',

  [ValidatePattern('^https?://[^\s]+$')]
  [string]$AdminBaseUrl = 'http://127.0.0.1:4173',

  [ValidatePattern('^https?://[^\s]+$')]
  [string]$AiRuntimeBaseUrl = 'http://127.0.0.1:8100',

  [string]$OutputDirectory = '',

  [switch]$AllowLoopbackHttp,

  [switch]$Deliver,

  [switch]$SendHealthy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseMonitoringProbeResult.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')

if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $BackupDirectory = Join-Path $PSScriptRoot '..\..\.data\backups'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\..\.data\monitoring'
}

function Invoke-ProbeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][ValidateSet('Core', 'Service')][string]$ProbeKind
  )

  try {
    $hostExecutable = (Get-Process -Id $PID -ErrorAction Stop).Path
    $output = & $hostExecutable -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $rendered = ($output | Out-String).Trim()
    return ConvertFrom-EnterpriseProbeProcessOutput `
      -Output $rendered `
      -ExitCode $exitCode `
      -ProbeKind $ProbeKind
  }
  catch {
    return New-EnterpriseProbeFailureResult -Alert 'PROBE_EXECUTION_FAILED'
  }
}

$coreArguments = @(
  '-Container', $Container,
  '-Database', $Database,
  '-DatabaseUser', $DatabaseUser,
  '-BackupDirectory', ([System.IO.Path]::GetFullPath($BackupDirectory))
)
if (-not [string]::IsNullOrWhiteSpace($ExpectedEmbeddingModel)) {
  $coreArguments += @('-ExpectedEmbeddingModel', $ExpectedEmbeddingModel)
}
$serviceArguments = @(
  '-ApiBaseUrl', $ApiBaseUrl,
  '-AdminBaseUrl', $AdminBaseUrl,
  '-AiRuntimeBaseUrl', $AiRuntimeBaseUrl
)
if ($AllowLoopbackHttp) { $serviceArguments += '-AllowLoopbackHttp' }

$core = Invoke-ProbeProcess `
  -ScriptPath (Join-Path $PSScriptRoot 'Test-EnterpriseCoreAlerts.ps1') `
  -Arguments $coreArguments `
  -ProbeKind Core
$services = Invoke-ProbeProcess `
  -ScriptPath (Join-Path $PSScriptRoot 'Test-EnterpriseServiceHealth.ps1') `
  -Arguments $serviceArguments `
  -ProbeKind Service
[object[]]$coreAlerts = @($core.alerts)
[object[]]$coreReadinessBlockers = @(
  if ($null -ne $core.PSObject.Properties['readinessBlockers']) {
    $core.readinessBlockers
  }
)
$alerts = @()
$alerts += @($coreAlerts | ForEach-Object { "CORE::$_" })
$alerts += @($coreReadinessBlockers | ForEach-Object { "CORE::$_" })
if ([string]$core.status -ne 'healthy' -and $coreAlerts.Count -eq 0 -and $coreReadinessBlockers.Count -eq 0) {
  $alerts += 'CORE::NOT_READY'
}
$alerts += @($services.alerts | ForEach-Object { "SERVICE::$_" })

$result = [ordered]@{
  status = if ($alerts.Count -eq 0) { 'healthy' } else { 'alerting' }
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  database = $Database
  core = $core
  services = $services
  alerts = $alerts
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$payloadPath = Join-Path $resolvedOutput 'latest-monitoring-result.json'
$payloadPersisted = $false
$payloadJson = $result | ConvertTo-Json -Depth 10
try {
  [System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
  Write-EnterpriseProtectedJsonAtomically -Path $payloadPath -Value $result -Depth 10
  $payloadPersisted = $true
}
catch {
  $result.status = 'alerting'
  $result.alerts += 'MONITORING_RESULT_PERSIST_FAILED'
  $payloadJson = $result | ConvertTo-Json -Depth 10
}

$delivery = $null
if ($Deliver -and ($result.status -eq 'alerting' -or $SendHealthy)) {
  try {
    $deliveryOutput = & (Join-Path $PSScriptRoot 'Send-EnterpriseAlert.ps1') -PayloadJson $payloadJson -AllowLoopbackHttp:$AllowLoopbackHttp
    $delivery = ($deliveryOutput | Out-String).Trim() | ConvertFrom-Json
  }
  catch {
    $delivery = [ordered]@{ status = 'failed' }
    $result.status = 'alerting'
    $result.alerts += 'ALERT_DELIVERY_FAILED'
    $payloadJson = $result | ConvertTo-Json -Depth 10
    if ($payloadPersisted) {
      try {
        Write-EnterpriseProtectedJsonAtomically -Path $payloadPath -Value $result -Depth 10
      }
      catch {
        $payloadPersisted = $false
        $result.alerts += 'MONITORING_RESULT_PERSIST_FAILED'
      }
    }
  }
}

[ordered]@{
  status = $result.status
  checkedAtUtc = $result.checkedAtUtc
  payloadPath = if ($payloadPersisted) { $payloadPath } else { $null }
  alertCount = $result.alerts.Count
  delivery = $delivery
} | ConvertTo-Json -Depth 5

if ($null -ne $delivery -and $delivery.status -eq 'failed') { exit 3 }
if ($result.status -ne 'healthy') { exit 2 }
