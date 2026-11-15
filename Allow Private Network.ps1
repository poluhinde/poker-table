# Run once from an elevated PowerShell, only if Windows Firewall blocks phones.
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe).Source
$ruleName = 'Poker Table Local TCP 3000'
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Program $nodePath -Profile Private -RemoteAddress LocalSubnet
}
Write-Host 'Poker server is allowed on the local subnet for Private networks.'
