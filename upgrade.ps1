param(
  [Parameter(Mandatory = $true)][string]$AfterJobId,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'WeChatT3Bridge')
)
$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
$dataPath = Join-Path $runtimePath 'data'
$entryPath = Join-Path $runtimePath 'src\bridge.mjs'
$statusPath = Join-Path $dataPath 'upgrade-status.json'
$utf8 = New-Object Text.UTF8Encoding($false)
function Set-UpgradeStatus([string]$Phase, [string]$Detail = '') {
  [IO.File]::WriteAllText($statusPath, (@{ phase = $Phase; detail = $Detail; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json), $utf8)
}
function Get-BridgeProcess {
  $processValue = Get-CimInstance Win32_Process -Filter "ProcessId = $ExpectedProcessId" -ErrorAction Stop
  if (-not $processValue -or $processValue.Name -ne 'node.exe' -or
      $processValue.CommandLine -notlike ('*' + $entryPath + '*')) { throw 'The expected bridge process is no longer running.' }
  return $processValue
}
$restartBegan = $false
$nextProcess = $null
$backupPath = $null
$supervisorPausePath = Join-Path $dataPath 'supervisor-pause.json'
$supervisorPaused = $false
try {
  $targetVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $installed = Get-Content -LiteralPath (Join-Path $runtimePath 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $initialProcess = Get-BridgeProcess
  $oldLock = Get-Content -LiteralPath (Join-Path $dataPath 'bridge.lock') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($oldLock.pid -ne $ExpectedProcessId) { throw 'Bridge lock does not match the expected process.' }
  $stagePath = Join-Path $runtimePath ('staged-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stagePath | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src') -Destination $stagePath -Recurse
  foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stagePath
  }
  # A stale snapshot may contain emojiNumber while threadLabel still emits #1.
  $probePath = Join-Path $stagePath 'verify-numbering.mjs'
  $probeCode = @'
import assert from 'node:assert/strict';
import { threadLabel } from './src/core.mjs';
for (const number of [1, 2, 10, 30]) {
  const prefix = String(number).replace(/\d/g, digit => `${digit}\uFE0F\u20E3`);
  assert.ok(threadLabel({threadId:'probe',title:'probe',number,shortId:'test'}).startsWith(prefix+' '), 'Staged thread numbers must use emoji');
}
'@
  [IO.File]::WriteAllText($probePath, $probeCode, $utf8)
  & $installed.node $probePath
  if ($LASTEXITCODE -ne 0) { throw 'The staged bridge failed its emoji numbering check; the running bridge was kept.' }
  Set-UpgradeStatus 'waiting_for_reply'
  $deadline = (Get-Date).AddMinutes(35)
  $ready = $false
  do {
    $currentProcess = Get-BridgeProcess
    if ($currentProcess.CreationDate -ne $initialProcess.CreationDate) { throw 'Bridge process identity changed.' }
    $state = Get-Content -LiteralPath (Join-Path $dataPath 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.seen -contains $AfterJobId -and @($state.jobs).Count -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (-not $ready) { throw 'Timed out waiting for the current WeChat reply; the running bridge was kept.' }

  # Recheck the executable, creation time, lock and inbox immediately before stopping.
  # Keep the startup supervisor from relaunching files while they are replaced.
  [IO.File]::WriteAllText($supervisorPausePath, (@{ pid = $PID } | ConvertTo-Json), $utf8)
  $supervisorPaused = $true
  $currentProcess = Get-BridgeProcess
  if ($currentProcess.CreationDate -ne $initialProcess.CreationDate) { throw 'Bridge process identity changed.' }
  $oldLock = Get-Content -LiteralPath (Join-Path $dataPath 'bridge.lock') -Raw -Encoding UTF8 | ConvertFrom-Json
  $state = Get-Content -LiteralPath (Join-Path $dataPath 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($oldLock.pid -ne $ExpectedProcessId -or @($state.jobs).Count -ne 0) { throw 'Bridge is busy again; retry the upgrade when idle.' }
  $backupPath = Join-Path $runtimePath ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backupPath | Out-Null
  Copy-Item -LiteralPath (Join-Path $runtimePath 'src') -Destination $backupPath -Recurse
  foreach ($name in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $runtimePath $name) -Destination $backupPath }
  Set-UpgradeStatus 'restarting'
  $restartBegan = $true
  Stop-Process -Id $ExpectedProcessId -Force
  $stoppedProcess = Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue
  if ($stoppedProcess) { $stoppedProcess.WaitForExit(5000) | Out-Null }
  Copy-Item -LiteralPath (Join-Path $stagePath 'src') -Destination $runtimePath -Recurse -Force
  foreach ($name in @('package.json', 'package-lock.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $stagePath $name) -Destination $runtimePath -Force }
  foreach ($stagedFile in Get-ChildItem -LiteralPath (Join-Path $stagePath 'src') -Filter '*.mjs' -File) {
    $installedFile = Join-Path (Join-Path $runtimePath 'src') $stagedFile.Name
    if ((Get-FileHash -LiteralPath $stagedFile.FullName).Hash -ne (Get-FileHash -LiteralPath $installedFile).Hash) {
      throw 'The installed bridge differs from the staged files.'
    }
  }
  $launchAt = (Get-Date).ToUniversalTime()
  $env:WECHAT_T3_DATA = $dataPath
  $nextProcess = Start-Process -FilePath $installed.node -ArgumentList @(('"' + $entryPath + '"'), 'run') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'bridge.log') -RedirectStandardError (Join-Path $dataPath 'bridge-error.log')
  $verified = $false
  $deadline = (Get-Date).AddSeconds(40)
  do {
    Start-Sleep -Milliseconds 500
    if ($nextProcess.HasExited) { throw 'The updated bridge exited before becoming healthy.' }
    $health = Get-Content -LiteralPath (Join-Path $dataPath 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($health.version -eq $targetVersion -and $health.replyNumberStyle -eq 'emoji' -and $health.connected -and $health.lastPollAt -and ([datetime]$health.lastPollAt).ToUniversalTime() -gt $launchAt) { $verified = $true; break }
  } while ((Get-Date) -lt $deadline)
  if (-not $verified) { throw 'The updated bridge did not report a successful WeChat poll.' }
  Set-UpgradeStatus 'complete' ('Version ' + $targetVersion + ' is running with emoji numbering and polling WeChat.')
} catch {
  $upgradeError = $_.Exception.Message
  if ($restartBegan -and $backupPath -and (Test-Path -LiteralPath (Join-Path $backupPath 'src'))) {
    try {
      if ($nextProcess -and -not $nextProcess.HasExited) { Stop-Process -Id $nextProcess.Id -Force }
      Copy-Item -LiteralPath (Join-Path $backupPath 'src') -Destination $runtimePath -Recurse -Force
      foreach ($name in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $backupPath $name) -Destination $runtimePath -Force }
      $env:WECHAT_T3_DATA = $dataPath
      Start-Process -FilePath $installed.node -ArgumentList @(('"' + $entryPath + '"'), 'run') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'rollback.log') -RedirectStandardError (Join-Path $dataPath 'rollback-error.log') | Out-Null
      Set-UpgradeStatus 'rolled_back' $upgradeError
    } catch { Set-UpgradeStatus 'error' ($upgradeError + ' Rollback also failed: ' + $_.Exception.Message) }
  } else { Set-UpgradeStatus 'error' $upgradeError }
  exit 1
} finally {
  if ($supervisorPaused -and (Test-Path -LiteralPath $supervisorPausePath)) {
    $pauseOwner = Get-Content -LiteralPath $supervisorPausePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pauseOwner.pid -eq $PID) { Remove-Item -LiteralPath $supervisorPausePath -Force }
  }
}
