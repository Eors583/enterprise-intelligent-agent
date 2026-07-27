function Quote-EnterpriseTaskArgument {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value.Contains('"')) {
    throw 'Task arguments must not contain quotation marks.'
  }
  return '"' + $Value + '"'
}

function New-EnterprisePowerShellTaskArgumentLine {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $resolvedScript = (Resolve-Path -LiteralPath $ScriptPath).Path
  $parts = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    (Quote-EnterpriseTaskArgument $resolvedScript)
  )
  # Do not place the string[] directly inside the array expression. PowerShell
  # preserves it as one object and `-join` renders the literal System.Object[].
  $parts += $Arguments
  $argumentLine = $parts -join ' '

  if ($argumentLine.IndexOf('System.Object[]', [StringComparison]::Ordinal) -ge 0) {
    throw 'Scheduled-task arguments were not flattened.'
  }
  return $argumentLine
}

function Assert-EnterpriseTaskArgumentLine {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ArgumentLine,
    [Parameter(Mandatory = $true)][string[]]$RequiredSwitches
  )

  if ($ArgumentLine.IndexOf('System.Object[]', [StringComparison]::Ordinal) -ge 0) {
    throw 'Scheduled-task action contains an unexpanded argument array.'
  }
  foreach ($requiredSwitch in $RequiredSwitches) {
    if ($ArgumentLine -notmatch ('(?:^|\s)' + [Regex]::Escape($requiredSwitch) + '(?:\s|$)')) {
      throw "Scheduled-task action is missing required switch '$requiredSwitch'."
    }
  }
}
