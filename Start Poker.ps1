param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
  $portablePath = Join-Path $PSScriptRoot '.portable'
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $systemVersion = if ($nodeCommand) { & $nodeCommand.Source --version } else { '' }

  if ($nodeCommand -and $npmCommand -and $systemVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) {
    $nodeExe = $nodeCommand.Source
    $npmCmd = $npmCommand.Source
  } else {
    $nodeVersion = 'v24.22.3'
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($architecture -notin @('x64', 'arm64')) { throw "Unsupported Windows architecture: $architecture" }

    $archiveName = "node-$nodeVersion-win-$architecture.zip"
    $nodePath = Join-Path $portablePath "node-$nodeVersion-win-$architecture"
    $nodeExe = Join-Path $nodePath 'node.exe'
    $npmCmd = Join-Path $nodePath 'npm.cmd'

    if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $npmCmd)) {
      New-Item -ItemType Directory -Path $portablePath -Force | Out-Null
      $baseUrl = "https://nodejs.org/dist/$nodeVersion"
      Write-Host "Downloading portable Node.js $nodeVersion ($architecture)..."
      $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 60).Content
      $checksumLine = @($checksums -split "`n" | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+" + [regex]::Escape($archiveName) + "\s*$") })
      if ($checksumLine.Count -ne 1) { throw "Could not find the checksum for $archiveName" }
      $expectedHash = ($checksumLine[0] -split '\s+')[0].ToLowerInvariant()
      $archivePath = Join-Path $portablePath $archiveName
      Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archivePath -TimeoutSec 600
      $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) {
        Remove-Item -LiteralPath $archivePath -Force
        throw "Node.js download checksum mismatch: $archiveName"
      }
      Expand-Archive -LiteralPath $archivePath -DestinationPath $portablePath -Force
      Remove-Item -LiteralPath $archivePath -Force
    }

    if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $npmCmd)) {
      throw 'Portable Node.js archive did not contain node.exe and npm.cmd.'
    }
    $env:PATH = "$nodePath;$env:PATH"
  }

  Write-Host "Using Node.js $(& $nodeExe --version)"
  New-Item -ItemType Directory -Path $portablePath -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $portablePath 'active-node.txt') -Value $nodeExe -NoNewline
  $lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
  $installStamp = Join-Path $portablePath 'package-lock.sha256'
  $installedHash = if (Test-Path -LiteralPath $installStamp) { (Get-Content -Raw -LiteralPath $installStamp).Trim() } else { '' }
  if (-not (Test-Path -LiteralPath 'node_modules') -or $installedHash -ne $lockHash) {
    Write-Host 'Installing project dependencies...'
    & $npmCmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    New-Item -ItemType Directory -Path $portablePath -Force | Out-Null
    Set-Content -LiteralPath $installStamp -Value $lockHash -NoNewline
  }

  Write-Host 'Building the current project...'
  & $npmCmd run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

  if ($PrepareOnly) { exit 0 }
  & $nodeExe (Join-Path $PSScriptRoot 'dist-server\server\index.js') --open
  if ($LASTEXITCODE -ne 0) { throw "Poker server exited with code $LASTEXITCODE" }
} catch {
  Write-Error $_
  exit 1
}
