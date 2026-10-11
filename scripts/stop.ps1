$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $projectRoot 'data\local-services.json'
if (!(Test-Path -LiteralPath $statePath)) { Write-Output 'No local service record.'; return }
foreach ($service in (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.id)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine.Contains($projectRoot)) {
        Stop-Process -Id $service.id -ErrorAction SilentlyContinue
    }
}
Write-Output 'Local services stopped. Detection data preserved.'

