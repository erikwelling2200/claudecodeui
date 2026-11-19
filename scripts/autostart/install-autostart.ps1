# Registers server-loop.ps1 as a per-user logon task (no admin rights needed) and starts it now.
# Run through `npm run autostart:install [-- -Port 3001]`. Re-running replaces the task.
param(
    [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$loop = Join-Path $PSScriptRoot 'server-loop.ps1'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# A backslash in a task name would mean a Task Scheduler folder, so the checkout is named by its folder only.
$taskName = "CloudCLI server $Port - $(Split-Path -Leaf $repo)"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$loop`" -Port $Port" `
    -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Zero disables the scheduler's default three-day limit, after which it would kill the loop.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Registered and started '$taskName'."
Write-Host "Log: $env:USERPROFILE\.cloudcli\logs\server-$Port.log"
Write-Host "Remove it with: npm run autostart:uninstall -- -Port $Port"
