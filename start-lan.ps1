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

    $expectedBuild = (Get-FileHash -LiteralPath $ServerScript -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $projectHashBytes = $sha256.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($ProjectRoot).ToLowerInvariant())
        )
        $expectedProject = ([BitConverter]::ToString($projectHashBytes) -replace '-', '').Substring(0, 12).ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
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

        $sameService = $health.ok -eq $true -and $health.service -eq "guandan-trainer"
        $sameBuild = $sameService -and $health.build -eq $expectedBuild -and $health.project -eq $expectedProject
        if ($sameBuild) {
            Write-Host ""
            Write-Host "Guandan Trainer is already running." -ForegroundColor Cyan
            Write-Host "Local URL: $url" -ForegroundColor Green
            Write-Host ""
            if (-not $NoBrowser) { Start-Process $url }
            exit 0
        }

        if ($sameService) {
            $listenerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
            $safeToRestart = $false
            if ($listenerPids.Count -eq 1) {
                $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listenerPids[0])" -ErrorAction SilentlyContinue
                $resolvedScript = [System.IO.Path]::GetFullPath($ServerScript)
                $safeToRestart = $null -ne $processInfo -and
                    $processInfo.CommandLine -and
                    $processInfo.CommandLine.IndexOf($resolvedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
            if (-not $safeToRestart) {
                throw "Port $Port is running an older Guandan service, but its process path cannot be verified. Close PID $($listenerPids -join ', ') and start again."
            }
            Write-Host "Detected an older Guandan service. Restarting it safely..." -ForegroundColor Yellow
            Stop-Process -Id $listenerPids[0] -ErrorAction Stop
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                Start-Sleep -Milliseconds 100
                if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { break }
            }
            if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
                throw "The older Guandan service did not release port $Port."
            }
        }
        else {
            throw "Fixed port $Port is being used by another program. Close that program and start again."
        }
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
