# Keeps the CloudCLI server of this checkout running: starts it, waits for it to exit, starts it again.
# A clean exit (the Restart button in the UI) restarts at once; a crash waits a few seconds first.
# Registered as a logon task by install-autostart.ps1; run it by hand to supervise a server in a console.
param(
    [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $env:USERPROFILE '.cloudcli\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "server-$Port.log"
$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) { throw "tsx is not installed in $repo; run npm install first" }

$env:CLOUDCLI_SUPERVISED = '1'
$env:SERVER_PORT = "$Port"
# The server resolves its checkout from the entry file, and the entry file from the working directory.
Set-Location $repo
$crashBackoffSeconds = 5
$maxLogBytes = 20MB

while ($true) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt $maxLogBytes) {
        Move-Item -Force $log "$log.1"
    }
    Add-Content $log "[autostart] $(Get-Date -Format s) starting server on port $Port"
    # Stderr lines arrive as error records; "$_" turns each back into its text. Continue, or the first one would end the loop.
    $ErrorActionPreference = 'Continue'
    & $node $tsx --tsconfig (Join-Path $repo 'server\tsconfig.json') (Join-Path $repo 'server\index.ts') 2>&1 | ForEach-Object { Add-Content $log -Value "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Add-Content $log "[autostart] $(Get-Date -Format s) server exited with code $code"
    if ($code -ne 0) { Start-Sleep -Seconds $crashBackoffSeconds }
}
