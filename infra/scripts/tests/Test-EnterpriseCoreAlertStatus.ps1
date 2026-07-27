$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseCoreAlertStatus.ps1')

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message Expected '$Expected', received '$Actual'."
  }
}

$tests = 0

$notEvaluated = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel '' `
  -CurrentChunkCount 0 `
  -MatchingEmbeddingCount 0 `
  -SchemaAvailable $true
Assert-Equal $notEvaluated.status 'not_evaluated' 'Omitting the model must not create semantic acceptance evidence.'
Assert-Equal $notEvaluated.evidenceVerified $false 'An unscoped vector check must not verify model evidence.'
$tests += 2

$emptyCorpus = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel 'text-embedding-model-immutable-version' `
  -CurrentChunkCount 0 `
  -MatchingEmbeddingCount 0 `
  -SchemaAvailable $true
Assert-Equal $emptyCorpus.status 'insufficient_evidence' 'An empty corpus must be inconclusive rather than ready.'
Assert-Equal $emptyCorpus.evidenceVerified $false 'An empty corpus must not verify embedding coverage.'
Assert-Equal $emptyCorpus.reason 'KNOWLEDGE_EMBEDDING_EVIDENCE_EMPTY' 'The empty-corpus boundary must be machine-readable.'
Assert-Equal `
  (Resolve-EnterpriseCoreProbeStatus -AlertCount 0 -SemanticReadiness $emptyCorpus) `
  'not_ready' `
  'An operationally healthy empty corpus must not produce a top-level healthy acceptance result.'
$tests += 4

$completeCoverage = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel 'text-embedding-model-immutable-version' `
  -CurrentChunkCount 3 `
  -MatchingEmbeddingCount 3 `
  -SchemaAvailable $true
Assert-Equal $completeCoverage.status 'ready' 'Non-empty complete coverage should be ready.'
Assert-Equal $completeCoverage.evidenceVerified $true 'Non-empty complete coverage should verify evidence.'
Assert-Equal `
  (Resolve-EnterpriseCoreProbeStatus -AlertCount 0 -SemanticReadiness $completeCoverage) `
  'healthy' `
  'Complete coverage with no operational alerts should be healthy.'
$tests += 3

$partialCoverage = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel 'text-embedding-model-immutable-version' `
  -CurrentChunkCount 3 `
  -MatchingEmbeddingCount 2 `
  -SchemaAvailable $true
Assert-Equal $partialCoverage.status 'coverage_incomplete' 'Partial coverage must not be ready.'
Assert-Equal $partialCoverage.evidenceVerified $false 'Partial coverage must not verify evidence.'
$tests += 2

$missingSchema = Resolve-EnterpriseSemanticReadiness `
  -ExpectedEmbeddingModel 'text-embedding-model-immutable-version' `
  -CurrentChunkCount 0 `
  -MatchingEmbeddingCount -1 `
  -SchemaAvailable $false
Assert-Equal $missingSchema.status 'schema_missing' 'A missing vector schema must be explicit.'
Assert-Equal `
  (Resolve-EnterpriseCoreProbeStatus -AlertCount 1 -SemanticReadiness $missingSchema) `
  'alerting' `
  'Operational alerts take precedence over readiness.'
$tests += 2

[ordered]@{
  status = 'passed'
  tests = $tests
} | ConvertTo-Json
