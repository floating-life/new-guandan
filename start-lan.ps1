[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerScript = Join-Path $ProjectRoot "lan_server.py"
$BindAddress = "127.0.0.1"
$Port = 20801
$url = "http://${BindAddress}:$Port/"

try {
    if (-not (Test-Path -LiteralPath $ServerScript -PathType Leaf)) {
        throw "Missing local server file: $ServerScript"
    }

    $listeners = @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    )
    if ($listeners) {
        $health = $null
        try {
            $health = Invoke-RestMethod -Uri "${url}healthz" -TimeoutSec 2 -ErrorAction Stop
        }
        catch {
            $health = $null
        }

        if ($health.ok -eq $true -and $health.service -eq "guandan-trainer") {
            Write-Host ""
            Write-Host "Guandan Trainer is already running." -ForegroundColor Cyan
            Write-Host "Local URL: $url" -ForegroundColor Green
            Write-Host ""
            if (-not $NoBrowser) { Start-Process $url }
            exit 0
        }

        throw "Fixed port $Port is being used by another program. Close that program and start again."
    }

    $python = Get-Command py -ErrorAction SilentlyContinue
    $useLauncher = $true
    if (-not $python) {
        $python = Get-Command python -ErrorAction SilentlyContinue
        $useLauncher = $false
    }
    if (-not $python) {
        throw "Python was not found. Install Python 3 and start again."
    }

    Write-Host ""
    Write-Host "Guandan Trainer - local launcher" -ForegroundColor Cyan
    Write-Host "Local URL: $url" -ForegroundColor Green
    Write-Host ""

    $serverArgs = @(
        $ServerScript
    )
    if (-not $NoBrowser) { $serverArgs += "--open-browser" }

    Set-Location -LiteralPath $ProjectRoot
    if ($useLauncher) {
        & $python.Source -3 @serverArgs
    }
    else {
        & $python.Source @serverArgs
    }
    exit $LASTEXITCODE
}
catch {
    Write-Host ""
    Write-Host "Start failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    exit 1
}
