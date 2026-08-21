param(
  [ValidateSet('person', 'group', 'mixed')]
  [string]$Profile = 'person',
  [int]$StartQps = 100,
  [int]$MaxQps = 800,
  [int]$DurationSeconds = 10,
  [int]$WarmupSeconds = 3,
  [int]$StableP99Milliseconds = 500
)

$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot '..\docker-compose.wukongim.dev.yml'
$container = 'enterprise-agent-wukongim-dev-wukongim-1'
$reportRoot = '/tmp/wkbench-capacity'

if ($StartQps -le 0 -or $MaxQps -lt $StartQps) {
  throw 'StartQps must be positive and MaxQps must be greater than or equal to StartQps.'
}
if ($DurationSeconds -le 0 -or $WarmupSeconds -le 0 -or $StableP99Milliseconds -le 0) {
  throw 'DurationSeconds, WarmupSeconds, and StableP99Milliseconds must be positive.'
}

docker compose -f $composeFile up -d --no-build | Out-Host
$health = docker inspect --format '{{.State.Health.Status}}' $container
if ($LASTEXITCODE -ne 0 -or $health.Trim() -ne 'healthy') {
  throw "WuKongIM acceptance container is not healthy (state: $health)."
}

docker exec $container rm -rf $reportRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not clear the previous in-container report.' }

docker exec $container wkbench capacity send `
  --api http://127.0.0.1:5001 `
  --gateway 127.0.0.1:5100 `
  --profile $Profile `
  --start-qps $StartQps `
  --max-qps $MaxQps `
  --step-factor 2 `
  --duration "${DurationSeconds}s" `
  --warmup "${WarmupSeconds}s" `
  --cooldown 1s `
  --stable-p99 "${StableP99Milliseconds}ms" `
  --min-actual-ratio 0.95 `
  --max-sendack-error-rate 0 `
  --max-connect-error-rate 0 `
  --binary-search=false `
  --report-dir $reportRoot
if ($LASTEXITCODE -ne 0) { throw "wkbench exited with code $LASTEXITCODE." }

$artifactRoot = Join-Path $PSScriptRoot '..\..\.data\wukongim-load-report'
if (Test-Path -LiteralPath $artifactRoot) {
  Remove-Item -LiteralPath $artifactRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
docker cp "${container}:${reportRoot}/." $artifactRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not export the wkbench report.' }

$resultPath = Join-Path $artifactRoot 'result.json'
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ($result.status -ne 'passed' -or [double]$result.max_stable_qps -lt $StartQps) {
  throw "Capacity gate failed: status=$($result.status), maxStableQps=$($result.max_stable_qps)."
}

Write-Output (ConvertTo-Json -Compress -Depth 8 ([ordered]@{
      status = $result.status
      profile = $result.profile
      maxStableQps = $result.max_stable_qps
      firstFailedQps = $result.first_failed_qps
      stableSendackP99Nanoseconds = $result.stable_attempt.sendack_p99
      report = (Resolve-Path -LiteralPath $resultPath).Path
    }))
