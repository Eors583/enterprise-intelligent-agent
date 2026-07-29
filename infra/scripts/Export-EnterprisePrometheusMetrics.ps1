[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$MonitoringResultPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseBackupStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\EnterprisePrometheusMetrics.ps1')

$resolvedInput = [System.IO.Path]::GetFullPath($MonitoringResultPath)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  throw 'Prometheus textfile output directory must already exist.'
}
$outputItem = Get-Item -LiteralPath $outputDirectory -Force
if (($outputItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Prometheus textfile output directory must not be a reparse point or symbolic link.'
}

$monitoringResult = Get-Content -LiteralPath $resolvedInput -Raw -Encoding utf8 | ConvertFrom-Json
$metrics = ConvertTo-EnterprisePrometheusMetrics -MonitoringResult $monitoringResult
$temporary = Join-Path $outputDirectory ('.' + [System.IO.Path]::GetFileName($resolvedOutput) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  [System.IO.File]::WriteAllText($temporary, $metrics, [System.Text.UTF8Encoding]::new($false))
  Set-EnterpriseRestrictedPathPermissions -Path $temporary -Directory $false
  if (Test-Path -LiteralPath $resolvedOutput) {
    $existing = Get-Item -LiteralPath $resolvedOutput -Force
    if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Prometheus textfile output must not be a reparse point or symbolic link.'
    }
    $replacementBackup = $temporary + '.previous'
    [System.IO.File]::Replace($temporary, $resolvedOutput, $replacementBackup)
    Remove-Item -LiteralPath $replacementBackup -Force
  }
  else {
    [System.IO.File]::Move($temporary, $resolvedOutput)
  }
  Set-EnterpriseRestrictedPathPermissions -Path $resolvedOutput -Directory $false
}
finally {
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}

[ordered]@{
  status = 'metrics-exported'
  inputPath = $resolvedInput
  outputPath = $resolvedOutput
  bytes = (Get-Item -LiteralPath $resolvedOutput).Length
} | ConvertTo-Json -Depth 4
