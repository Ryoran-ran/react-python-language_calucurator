param([switch]$Development)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$portablePython = Join-Path $taskRoot '.runtime/python/python.exe'
$venvPython = Join-Path $taskRoot '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath $portablePython) {
    $pythonExe = $portablePython
    [System.IO.File]::WriteAllLines((Join-Path $taskRoot '.runtime/python/python312._pth'), @('python312.zip', '.', $taskRoot, 'import site'), (New-Object System.Text.UTF8Encoding($false)))
} elseif (Test-Path -LiteralPath $venvPython) {
    $pythonExe = $venvPython
} else {
    throw 'Run setup first: Python 3.12 virtual environment and backend/requirements.lock.txt are required. See README.md.'
}
$portableNode = Join-Path $taskRoot '.runtime/node-v22.23.0-win-x64'
if (Test-Path -LiteralPath $portableNode) { $env:Path = "$portableNode;$env:Path" }
$env:PYTHONIOENCODING = 'utf-8'
if ($Development) {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $viteCli = Join-Path $taskRoot 'frontend/node_modules/vite/bin/vite.js'
    $viteArgs = @('"' + $viteCli + '"', '--host', '127.0.0.1')
    $viteProcess = Start-Process -FilePath $nodeExe -ArgumentList $viteArgs -WorkingDirectory (Join-Path $taskRoot 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot '.runtime-vite.log') -RedirectStandardError (Join-Path $taskRoot '.runtime-vite-error.log')
    Write-Host 'Open http://127.0.0.1:5173/'
    try { & $pythonExe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload }
    finally { if (!$viteProcess.HasExited) { Stop-Process -Id $viteProcess.Id } }
} else {
    if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'frontend/dist/index.html'))) { throw 'Build the frontend first: cd frontend; npm ci; npm run build' }
    Write-Host 'Open http://127.0.0.1:8000/'
    & $pythonExe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
}
