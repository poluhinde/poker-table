# Run once from an elevated PowerShell, only if Windows Firewall blocks phones.
$ErrorActionPreference = 'Stop'
$activeNodePath = Join-Path $PSScriptRoot '.portable\active-node.txt'
if (-not (Test-Path -LiteralPath $activeNodePath)) { throw 'Run Start Poker.cmd once before configuring the firewall.' }
$nodePath = (Get-Content -Raw -LiteralPath $activeNodePath).Trim()
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js executable is missing. Run Start Poker.cmd again.' }
$ruleName = 'Poker Table Local TCP 3000'
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  $filter = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule
  if ($filter.Program -ne $nodePath) { $filter | Set-NetFirewallApplicationFilter -Program $nodePath | Out-Null }
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Program $nodePath -Profile Private -RemoteAddress LocalSubnet
}
Write-Host 'Poker server is allowed on the local subnet for Private networks.'
