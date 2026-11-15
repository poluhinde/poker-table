$ErrorActionPreference = 'Stop'
try {
  $serverPort = if ($env:PORT) { [int]$env:PORT } else { 3000 }
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $serverPort })
  if ($listeners.Count -eq 0) { Write-Host 'Poker server is already stopped.'; exit 0 }
  $statePath = Join-Path $PSScriptRoot 'data\table.json'
  $savedTable = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://localhost:" + $serverPort + "/api/host-info") -Headers @{Authorization=("Bearer " + $savedTable.hostKey)} -TimeoutSec 5
  if ($response.StatusCode -ne 200) { throw 'Could not authenticate the existing poker server.' }
  $serverProcesses = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Get-CimInstance Win32_Process -Filter ("ProcessId = " + $_) })
  foreach ($serverProcess in $serverProcesses) {
    if ($serverProcess.Name -ne 'node.exe' -or $serverProcess.CommandLine -notmatch 'dist-server[/\\]server[/\\]index\.js') {
      throw 'Port is owned by an unexpected process. Nothing was stopped.'
    }
  }
  foreach ($serverProcess in $serverProcesses) {
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $serverProcess.ProcessId)
    if ($current.CreationDate -ne $serverProcess.CreationDate) { throw 'Server process changed. Retry.' }
    Stop-Process -Id $serverProcess.ProcessId
  }
  foreach ($serverProcess in $serverProcesses) {
    if (Get-Process -Id $serverProcess.ProcessId -ErrorAction SilentlyContinue) {
      Wait-Process -Id $serverProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
  }
  Write-Host 'Poker server stopped. Table data is saved.'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
