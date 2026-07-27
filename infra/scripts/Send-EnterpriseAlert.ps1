[CmdletBinding(DefaultParameterSetName = 'Path')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Path')]
  [string]$PayloadPath,

  [Parameter(Mandatory = $true, ParameterSetName = 'Json')]
  [ValidateLength(1, 1048576)]
  [string]$PayloadJson,

  [ValidatePattern('^[A-Z][A-Z0-9_]{2,127}$')]
  [string]$WebhookUrlEnvironmentVariable = 'ENTERPRISE_ALERT_WEBHOOK_URL',

  [ValidatePattern('^[A-Z][A-Z0-9_]{2,127}$')]
  [string]$BearerTokenEnvironmentVariable = 'ENTERPRISE_ALERT_WEBHOOK_BEARER_TOKEN',

  [ValidatePattern('^[A-Z][A-Z0-9_]{2,127}$')]
  [string]$SigningKeyEnvironmentVariable = 'ENTERPRISE_ALERT_WEBHOOK_SIGNING_KEY',

  [ValidateRange(1, 60)]
  [int]$TimeoutSeconds = 10,

  [switch]$AllowLoopbackHttp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'lib\EnterpriseAlertSigning.ps1')

$payload = if ($PSCmdlet.ParameterSetName -eq 'Path') {
  $resolvedPayload = [System.IO.Path]::GetFullPath($PayloadPath)
  if (-not (Test-Path -LiteralPath $resolvedPayload -PathType Leaf)) {
    throw 'Alert payload file was not found.'
  }
  Get-Content -LiteralPath $resolvedPayload -Raw -Encoding utf8
}
else {
  $PayloadJson
}
$payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
if ($payloadBytes.Length -le 0 -or $payloadBytes.Length -gt 1MB) {
  throw 'Alert payload must contain between 1 byte and 1 MiB.'
}
try {
  $null = $payload | ConvertFrom-Json
}
catch {
  throw 'Alert payload must be valid JSON.'
}

$webhookValue = [Environment]::GetEnvironmentVariable($WebhookUrlEnvironmentVariable)
if ([string]::IsNullOrWhiteSpace($webhookValue)) {
  throw "The alert webhook environment variable is not configured."
}
try {
  $webhook = [Uri]$webhookValue
}
catch {
  throw 'The alert webhook environment variable is not a valid absolute URI.'
}
if (-not $webhook.IsAbsoluteUri -or $webhook.UserInfo.Length -gt 0 -or $webhook.Fragment.Length -gt 0) {
  throw 'The alert webhook must be an absolute URI without embedded credentials or a fragment.'
}
if ($webhook.Scheme -ne 'https' -and -not ($AllowLoopbackHttp -and $webhook.IsLoopback)) {
  throw 'The alert webhook must use HTTPS; loopback HTTP is test-only.'
}

$deliveryTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$headers = @{
  'X-Enterprise-Alert-Timestamp' = $deliveryTimestamp
}
$bearerToken = [Environment]::GetEnvironmentVariable($BearerTokenEnvironmentVariable)
if (-not [string]::IsNullOrWhiteSpace($bearerToken)) {
  $headers.Authorization = "Bearer $bearerToken"
}
$signingKey = [Environment]::GetEnvironmentVariable($SigningKeyEnvironmentVariable)
if (-not [string]::IsNullOrWhiteSpace($signingKey)) {
  $signedPayload = $deliveryTimestamp + '.' + $payload
  $headers['X-Enterprise-Alert-Signature'] = 'sha256=' + (Get-EnterpriseHmacSha256Hex -Key $signingKey -Message $signedPayload)
}

try {
  $null = Invoke-RestMethod `
    -Uri $webhook `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body $payloadBytes `
    -MaximumRedirection 0 `
    -TimeoutSec $TimeoutSeconds
}
catch {
  throw 'Alert delivery failed; the destination and response body were suppressed.'
}

[ordered]@{
  status = 'delivered'
  deliveredAtUtc = [DateTime]::UtcNow.ToString('o')
  signed = -not [string]::IsNullOrWhiteSpace($signingKey)
  authenticated = -not [string]::IsNullOrWhiteSpace($bearerToken)
} | ConvertTo-Json -Depth 3
