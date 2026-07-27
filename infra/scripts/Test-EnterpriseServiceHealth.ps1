[CmdletBinding()]
param(
  [ValidatePattern('^https?://[^\s]+$')]
  [string]$ApiBaseUrl = 'http://127.0.0.1:3000',

  [ValidatePattern('^https?://[^\s]+$')]
  [string]$AdminBaseUrl = 'http://127.0.0.1:4173',

  [ValidatePattern('^https?://[^\s]+$')]
  [string]$AiRuntimeBaseUrl = 'http://127.0.0.1:8100',

  [ValidateRange(1, 60)]
  [int]$TimeoutSeconds = 5,

  [switch]$AllowLoopbackHttp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-ServiceUri {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $base = [Uri]$BaseUrl
  if (-not $base.IsAbsoluteUri -or $base.UserInfo.Length -gt 0 -or $base.Query.Length -gt 0 -or $base.Fragment.Length -gt 0) {
    throw "Service URL must be an absolute origin without credentials, query, or fragment."
  }
  $loopback = $base.IsLoopback
  if ($base.Scheme -ne 'https' -and -not ($AllowLoopbackHttp -and $loopback)) {
    throw 'Service health probes require HTTPS; use -AllowLoopbackHttp only for local validation.'
  }
  return [Uri]::new(($base.AbsoluteUri.TrimEnd('/') + $Path))
}

function Invoke-HealthRequest {
  param(
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [string]$ExpectedJsonStatus = ''
  )

  try {
    $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec $TimeoutSeconds -UseBasicParsing -MaximumRedirection 0
    $httpReady = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
    if (-not $httpReady) {
      return [ordered]@{ reachable = $true; ready = $false; httpStatus = [int]$response.StatusCode }
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedJsonStatus)) {
      return [ordered]@{ reachable = $true; ready = $true; httpStatus = [int]$response.StatusCode }
    }

    try {
      $body = $response.Content | ConvertFrom-Json
      $ready = [string]$body.status -eq $ExpectedJsonStatus
      return [ordered]@{ reachable = $true; ready = $ready; httpStatus = [int]$response.StatusCode }
    }
    catch {
      return [ordered]@{ reachable = $true; ready = $false; httpStatus = [int]$response.StatusCode }
    }
  }
  catch {
    $status = $null
    $responseProperty = $_.Exception.PSObject.Properties['Response']
    if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
      $statusCodeProperty = $responseProperty.Value.PSObject.Properties['StatusCode']
      if ($null -ne $statusCodeProperty -and $null -ne $statusCodeProperty.Value) {
        $status = [int]$statusCodeProperty.Value
      }
    }
    return [ordered]@{ reachable = $null -ne $status; ready = $false; httpStatus = $status }
  }
}

$apiLive = Invoke-HealthRequest -Uri (Resolve-ServiceUri -BaseUrl $ApiBaseUrl -Path '/health/live') -ExpectedJsonStatus 'ok'
$apiReady = Invoke-HealthRequest -Uri (Resolve-ServiceUri -BaseUrl $ApiBaseUrl -Path '/health/ready') -ExpectedJsonStatus 'ready'
$admin = Invoke-HealthRequest -Uri (Resolve-ServiceUri -BaseUrl $AdminBaseUrl -Path '/')
$aiRuntime = Invoke-HealthRequest -Uri (Resolve-ServiceUri -BaseUrl $AiRuntimeBaseUrl -Path '/health/ready') -ExpectedJsonStatus 'ready'

$alerts = @()
if (-not $apiLive.ready) { $alerts += 'API_LIVENESS_FAILED' }
if (-not $apiReady.ready) { $alerts += 'API_READINESS_FAILED' }
if (-not $admin.ready) { $alerts += 'ADMIN_HTTP_FAILED' }
if (-not $aiRuntime.ready) { $alerts += 'AI_RUNTIME_READINESS_FAILED' }

$result = [ordered]@{
  status = if ($alerts.Count -eq 0) { 'healthy' } else { 'alerting' }
  checkedAtUtc = [DateTime]::UtcNow.ToString('o')
  services = [ordered]@{
    apiLive = $apiLive
    apiReady = $apiReady
    admin = $admin
    aiRuntime = $aiRuntime
  }
  alerts = $alerts
}
$result | ConvertTo-Json -Depth 5
if ($alerts.Count -gt 0) { exit 2 }
