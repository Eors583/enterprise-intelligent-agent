function ConvertTo-EnterpriseLowerHex {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  # BitConverter is available on Windows PowerShell 5.1; Convert.ToHexString is
  # not available on the .NET Framework host used by scheduled tasks.
  return ([System.BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-EnterpriseHmacSha256Hex {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($Key))
  try {
    $hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Message))
    return ConvertTo-EnterpriseLowerHex -Bytes $hash
  }
  finally {
    $hmac.Dispose()
  }
}
