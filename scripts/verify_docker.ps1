param(
    [switch]$Observability,
    [ValidateRange(1, 600)][int]$EngineTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI not found. Install and start Docker Desktop, then open a new PowerShell terminal.'
}

$composeArgs = @('compose', '-f', (Join-Path $projectRoot 'compose.yaml'), '-f', (Join-Path $projectRoot 'compose.postgres.yaml'))
if ($Observability) {
    $composeArgs += @('-f', (Join-Path $projectRoot 'compose.observability.yaml'))
}

function Invoke-DriftCompose {
    param([string[]]$CommandArgs)
    & docker @composeArgs @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed: $($CommandArgs -join ' ')"
    }
}

function Assert-DriftStorageSpace {
    # Docker stores images/volumes on its own disk, independent of the project's drive.
    $storageRoot = Join-Path $env:LOCALAPPDATA 'Docker\wsl'
    $settingsFile = Join-Path $env:APPDATA 'Docker\settings-store.json'
    if (Test-Path -LiteralPath $settingsFile) {
        $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        foreach ($settingName in @('DataFolder', 'DiskImageLocation')) {
            $property = $settings.PSObject.Properties[$settingName]
            if ($property -and $property.Value -is [string] -and [System.IO.Path]::IsPathRooted($property.Value)) {
                $storageRoot = $property.Value
                break
            }
        }
    }
    $driveRoot = [System.IO.Path]::GetPathRoot($storageRoot)
    $drive = New-Object System.IO.DriveInfo -ArgumentList $driveRoot
    if ($drive.IsReady -and $drive.AvailableFreeSpace -lt 5GB) {
        $freeGiB = [Math]::Round($drive.AvailableFreeSpace / 1GB, 2)
        throw "Docker data location '$storageRoot' is on $driveRoot with only $freeGiB GiB free. At least 5 GiB is required by this verifier before building. Free space or move Docker's disk image to another drive in Docker Desktop Settings > Resources > Advanced. Project containers have not been started."
    }
}

function Wait-DriftEngine {
    # A named pipe may exist while Desktop is still starting. Bound each CLI
    # probe too, because docker info can hang until the engine responds.
    $waitClock = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host "Waiting up to $EngineTimeoutSeconds seconds for Docker's Linux engine..."
    while ($waitClock.Elapsed.TotalSeconds -lt $EngineTimeoutSeconds) {
        $probe = New-Object System.Diagnostics.Process
        $probe.StartInfo.FileName = (Get-Command docker).Source
        $probe.StartInfo.Arguments = 'info --format "{{.OSType}}"'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.RedirectStandardOutput = $true
        $probe.StartInfo.RedirectStandardError = $true
        $osType = $null
        try {
            $null = $probe.Start()
            $probeOutput = $probe.StandardOutput.ReadToEndAsync()
            $probeError = $probe.StandardError.ReadToEndAsync()
            $remainingMs = [int][Math]::Max(1, ($EngineTimeoutSeconds - $waitClock.Elapsed.TotalSeconds) * 1000)
            if ($probe.WaitForExit([Math]::Min(5000, $remainingMs))) {
                if ($probe.ExitCode -eq 0) {
                    $osType = $probeOutput.GetAwaiter().GetResult().Trim()
                }
            } else {
                $probe.Kill() # Only this script's Docker CLI probe; preserves Desktop and all containers.
                $null = $probe.WaitForExit(1000)
            }
        } finally {
            $probe.Dispose()
        }
        if ($osType -eq 'linux') { return }
        if ($osType) { throw 'Switch Docker Desktop to Linux containers before running this project.' }
        $remainingMs = [int][Math]::Max(0, ($EngineTimeoutSeconds - $waitClock.Elapsed.TotalSeconds) * 1000)
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(2000, $remainingMs)) }
    }
    throw "Docker Linux engine did not become ready within $EngineTimeoutSeconds seconds. Check 'docker desktop status' and the Docker Desktop startup error; confirm 'wsl --version' works. Project containers have not been started."
}

function Wait-DriftHealth {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
            if ($health.status -eq 'ok' -and $health.analyzer -eq $true -and $health.database -eq 'PostgreSQL') {
                return $health
            }
        } catch {
            # Containers can be running before the application begins listening.
        }
        Start-Sleep -Seconds 2
    }
    throw 'PostgreSQL application health check failed. Inspect docker compose logs for gateway, analyzer and postgres.'
}

Push-Location $projectRoot
try {
    Assert-DriftStorageSpace
    Wait-DriftEngine

    Invoke-DriftCompose -CommandArgs @('config', '--quiet')
    Invoke-DriftCompose -CommandArgs @('up', '--build', '-d', '--wait', '--wait-timeout', '180')
    $health = Wait-DriftHealth
    Write-Host "PASS: HTTP health reports $($health.database), analyzer online."

    # Runs through Nginx, Rust, Python and PostgreSQL; no host Python is required.
    # Creates five synthetic records and sets a demo baseline; no paid API calls.
    Invoke-DriftCompose -CommandArgs @('cp', 'scripts/smoke.py', 'analyzer:/tmp/drift-smoke.py')
    Invoke-DriftCompose -CommandArgs @('exec', '-T', 'analyzer', 'python', '/tmp/drift-smoke.py', '--base-url', 'http://web/api', '--expect-database', 'PostgreSQL')

    $sql = "SELECT COUNT(*) FROM runs WHERE status = 'completed';"
    $count = Invoke-DriftCompose -CommandArgs @('exec', '-T', 'postgres', 'psql', '-U', 'drift', '-d', 'drift', '-At', '-c', $sql)
    if ([int]($count -join '').Trim() -lt 5) { throw 'Expected at least five completed PostgreSQL records.' }
    Write-Host "PASS: PostgreSQL has $($count -join '') completed records."

    $before = Invoke-RestMethod 'http://127.0.0.1:3000/api/runs' -TimeoutSec 10
    $expectedIds = @($before.runs | ForEach-Object { $_.id } | Sort-Object)
    Invoke-DriftCompose -CommandArgs @('restart', 'postgres', 'gateway')
    $health = Wait-DriftHealth
    $after = Invoke-RestMethod 'http://127.0.0.1:3000/api/runs' -TimeoutSec 10
    $actualIds = @($after.runs | ForEach-Object { $_.id } | Sort-Object)
    if (($expectedIds -join ',') -ne ($actualIds -join ',') -or $before.baseline_id -ne $after.baseline_id) {
        throw 'Records or baseline changed after restarting PostgreSQL and the gateway.'
    }
    Write-Host 'PASS: records and baseline survived PostgreSQL/gateway restart.'
    Write-Host 'Application: http://127.0.0.1:3000'
    if ($Observability) {
        Write-Host 'Jaeger: http://127.0.0.1:16686 (select drift-gateway or drift-analyzer to inspect the smoke test traces).'
    }
    Write-Host 'Verification finished. Containers and database volumes remain available.'
} finally {
    Pop-Location
}
