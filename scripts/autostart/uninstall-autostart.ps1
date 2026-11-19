# Stops the supervised server, ends the loop and removes the logon task registered by install-autostart.ps1.
param(
    [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# A backslash in a task name would mean a Task Scheduler folder, so the checkout is named by its folder only.
$taskName = "CloudCLI server $Port - $(Split-Path -Leaf $repo)"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "No task named '$taskName'."
} else {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed '$taskName'."
}

# Ending the task ends the loop, but the node process it started may survive it; the server's marker names that process.
$marker = Join-Path $env:USERPROFILE '.cloudcli\local-server.json'
if (Test-Path $marker) {
    $info = Get-Content $marker -Raw | ConvertFrom-Json
    if ($info.port -eq $Port -and $info.pid) {
        $process = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.Name -eq 'node') {
            Stop-Process -Id $info.pid -Force
            Write-Host "Stopped server process $($info.pid)."
        }
    }
}
