[CmdletBinding(SupportsShouldProcess)]
param([string]$TaskName = 'HERMESS Discord Orchestrator')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-runtime.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.js'))) { throw 'Run npm install and npm run build first.' }
$powerShell = (Get-Command powershell.exe).Source
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity.Name -LogonType Interactive -RunLevel Highest
if ($PSCmdlet.ShouldProcess($TaskName, 'Register startup and watchdog task')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State
}
