param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot

# Parse assignments as data, never evaluate shell content. Keep credentials out of output.
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    Get-Content -LiteralPath $envPath | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $configKey = $Matches[1]
            $configValue = $Matches[2].Trim().Trim('"').Trim("'")
            if ($configKey -notin @('HOME','CODEX_HOME','PATH','RUSTUP_HOME','CARGO_HOME')) {
                [Environment]::SetEnvironmentVariable($configKey, $configValue, 'Process')
            }
        }
    }
}
$cargoPath = Join-Path $projectRoot '.tools\cargo\bin\cargo.exe'
if (Test-Path -LiteralPath $cargoPath) {
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:PATH = "$(Split-Path $cargoPath);$env:PATH"
} else { $cargoPath = (Get-Command cargo -ErrorAction Stop).Source }
$mingwPath = Join-Path $projectRoot '.tools\winlibs\mingw64\bin'
if (Test-Path -LiteralPath $mingwPath) {
    $env:PATH = "$mingwPath;$env:PATH"
    $env:CC = Join-Path $mingwPath 'gcc.exe'
    $env:AR = Join-Path $mingwPath 'ar.exe'
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $mingwPath 'gcc.exe'
}
$pythonPath = Join-Path $projectRoot 'analyzer\.venv\Scripts\python.exe'
$gatewayPath = Join-Path $projectRoot 'gateway\target\debug\drift-gateway.exe'
$vitePath = Join-Path $projectRoot 'web\node_modules\vite\bin\vite.js'
if ($Build -or !(Test-Path -LiteralPath $pythonPath)) {
    uv sync --project analyzer
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency install failed.' }
}
if ($Build -or !(Test-Path -LiteralPath $vitePath)) {
    npm ci --prefix web --cache .tools/npm-cache --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency install failed.' }
}
if ($Build -or !(Test-Path -LiteralPath $gatewayPath)) {
    & $cargoPath build --locked --manifest-path gateway\Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Rust gateway build failed.' }
}
$statePath = Join-Path $projectRoot 'data\local-services.json'
if (Test-Path -LiteralPath $statePath) {
    $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($existing | Where-Object { Get-Process -Id $_.id -ErrorAction SilentlyContinue }) {
        throw 'Existing local services found. Run scripts/stop.ps1 before starting again.'
    }
}
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'data') -Force | Out-Null
$processes = @()
try {
    $processes += Start-Process -FilePath $pythonPath -ArgumentList @('-m','uvicorn','drift.app:app','--host','127.0.0.1','--port','8001') -WorkingDirectory (Join-Path $projectRoot 'analyzer') -WindowStyle Hidden -RedirectStandardOutput 'data\analyzer.log' -RedirectStandardError 'data\analyzer-error.log' -PassThru
    $processes += Start-Process -FilePath $gatewayPath -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput 'data\gateway.log' -RedirectStandardError 'data\gateway-error.log' -PassThru
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $processes += Start-Process -FilePath $nodePath -ArgumentList @(('"' + $vitePath + '"'),'--host','127.0.0.1','--port','5173') -WorkingDirectory (Join-Path $projectRoot 'web') -WindowStyle Hidden -RedirectStandardOutput 'data\web.log' -RedirectStandardError 'data\web-error.log' -PassThru
    $processes | ForEach-Object { @{id=$_.Id; executable=$_.Path} } | ConvertTo-Json | Set-Content -LiteralPath $statePath
    $ready = $false
    for ($attempt=0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 300
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 2
            $web = Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -TimeoutSec 2
            if ($health.status -eq 'ok' -and $web.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (!$ready) { throw 'Services failed to start. Inspect data/*-error.log.' }
    Write-Output 'Codex Drift ready: http://127.0.0.1:5173'
} catch {
    foreach ($process in $processes) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw
}
