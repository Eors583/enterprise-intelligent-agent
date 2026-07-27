function Resolve-EnterpriseSemanticReadiness {
  [CmdletBinding()]
  param(
    [AllowEmptyString()]
    [string]$ExpectedEmbeddingModel = '',

    [ValidateRange(0, [int]::MaxValue)]
    [int]$CurrentChunkCount,

    [ValidateRange(-1, [int]::MaxValue)]
    [int]$MatchingEmbeddingCount,

    [bool]$SchemaAvailable
  )

  $required = -not [string]::IsNullOrWhiteSpace($ExpectedEmbeddingModel)

  if (-not $SchemaAvailable) {
    return [ordered]@{
      required = $required
      status = 'schema_missing'
      evidenceVerified = $false
      reason = 'SEMANTIC_SCHEMA_MISSING'
    }
  }

  if (-not $required) {
    return [ordered]@{
      required = $false
      status = 'not_evaluated'
      evidenceVerified = $false
      reason = 'EXPECTED_EMBEDDING_MODEL_NOT_PROVIDED'
    }
  }

  if ($CurrentChunkCount -eq 0) {
    return [ordered]@{
      required = $true
      status = 'insufficient_evidence'
      evidenceVerified = $false
      reason = 'KNOWLEDGE_EMBEDDING_EVIDENCE_EMPTY'
    }
  }

  if ($MatchingEmbeddingCount -lt 0 -or $MatchingEmbeddingCount -gt $CurrentChunkCount) {
    throw 'Matching embedding count is outside the valid current-chunk range.'
  }

  if ($MatchingEmbeddingCount -lt $CurrentChunkCount) {
    return [ordered]@{
      required = $true
      status = 'coverage_incomplete'
      evidenceVerified = $false
      reason = 'KNOWLEDGE_EMBEDDING_GAP'
    }
  }

  return [ordered]@{
    required = $true
    status = 'ready'
    evidenceVerified = $true
    reason = $null
  }
}

function Resolve-EnterpriseCoreProbeStatus {
  [CmdletBinding()]
  param(
    [ValidateRange(0, [int]::MaxValue)]
    [int]$AlertCount,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$SemanticReadiness
  )

  if ($AlertCount -gt 0) {
    return 'alerting'
  }

  if ([bool]$SemanticReadiness.required -and -not [bool]$SemanticReadiness.evidenceVerified) {
    return 'not_ready'
  }

  return 'healthy'
}
