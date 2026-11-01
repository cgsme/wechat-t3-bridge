param(
  [Parameter(Mandatory = $true)][string]$ThreadId,
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'WeChatT3Bridge')
)
$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
$sourcePath = $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$t3Launcher = Join-Path $env:USERPROFILE '.t3\bin\t3.cmd'
$launcherText = Get-Content -LiteralPath $t3Launcher -Raw
$launcherMatch = [regex]::Match($launcherText, '(?m)^"([^"]+\.exe)" "([^"]+bin\.mjs)" %\*')
if (-not $launcherMatch.Success) { throw 'Cannot resolve the installed T3 launcher.' }
$t3Executable = $launcherMatch.Groups[1].Value
$t3Entry = $launcherMatch.Groups[2].Value
if (-not (Test-Path -LiteralPath $t3Executable)) { throw 'T3 desktop executable is missing.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $runtimePath /inheritance:r /grant:r "*${userSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict access to the bridge directory.' }
$dataPath = Join-Path $runtimePath 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourcePath 'src') -Destination $runtimePath -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourcePath 'node_modules') -Destination $runtimePath -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourcePath 'package.json') -Destination $runtimePath -Force
Copy-Item -LiteralPath (Join-Path $sourcePath 'README.md') -Destination $runtimePath -Force
$configValue = @{
  threadId = $ThreadId; cwd = $sourcePath; command = $t3Executable; desktopCommand = $t3Executable; prefixArgs = @($t3Entry)
  env = @{ ELECTRON_RUN_AS_NODE = '1'; T3CODE_DESKTOP_CLI_LAUNCHER = '1'; T3CODE_HOME = (Join-Path $env:USERPROFILE '.t3') }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $dataPath 'config.json'), ($configValue | ConvertTo-Json -Depth 5), $utf8)
$entryPath = Join-Path $runtimePath 'src\bridge.mjs'
$supervisorPath = Join-Path $runtimePath 'src\supervisor.mjs'
$commandLine = '"' + $nodePath + '" "' + $supervisorPath + '"'
$vbs = 'Set bridgeShell = CreateObject("WScript.Shell")' + "`r`n" +
  'bridgeShell.Environment("PROCESS")("WECHAT_T3_DATA") = "' + $dataPath.Replace('"', '""') + '"' + "`r`n" +
  'bridgeShell.Run "' + $commandLine.Replace('"', '""') + '", 0, False' + "`r`n"
$startPath = Join-Path $runtimePath 'Start.vbs'
[IO.File]::WriteAllText($startPath, $vbs, [Text.Encoding]::Unicode)
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'WeChatT3Bridge.vbs'
Copy-Item -LiteralPath $startPath -Destination $startupPath -Force
[IO.File]::WriteAllText((Join-Path $runtimePath 'installation.json'), (@{
  node = $nodePath; entry = $entryPath; supervisor = $supervisorPath; data = $dataPath; startup = $startupPath; source = $sourcePath
} | ConvertTo-Json), $utf8)
Write-Output "Installed: $runtimePath"
Write-Output 'Startup enabled. The bridge will accept only the WeChat account that scans the login QR.'
