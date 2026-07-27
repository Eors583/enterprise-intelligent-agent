$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\lib\EnterpriseAlertSigning.ps1')

$hex = ConvertTo-EnterpriseLowerHex -Bytes ([byte[]](0, 1, 255))
if ($hex -ne '0001ff') { throw "PS5-compatible hex conversion failed: $hex" }

$signature = Get-EnterpriseHmacSha256Hex `
  -Key 'key' `
  -Message 'The quick brown fox jumps over the lazy dog'
if ($signature -ne 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8') {
  throw "HMAC-SHA256 test vector failed: $signature"
}

[ordered]@{ status = 'passed'; tests = 2 } | ConvertTo-Json
