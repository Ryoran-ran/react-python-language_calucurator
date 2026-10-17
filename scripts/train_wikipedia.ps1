[CmdletBinding()]
param(
    [ValidateSet('prepare', 'train', 'all')]
    [string]$Stage = 'all',
    [string]$Dump = '',
    [string]$Corpus = '',
    [string]$Output = '',
    [int]$MaxArticles = 0,
    [int]$VectorSize = 100,
    [int]$MaxVocabulary = 100000,
    [int]$MinCount = 20,
    [int]$Epochs = 5,
    [int]$Workers = 0,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$portablePython = Join-Path $taskRoot '.runtime/python/python.exe'
$venvPython = Join-Path $taskRoot '.venv/Scripts/python.exe'
if (Test-Path -LiteralPath $portablePython) {
    $pythonExe = $portablePython
} elseif (Test-Path -LiteralPath $venvPython) {
    $pythonExe = $venvPython
} else {
    throw 'Python is not configured. Complete the setup in README.md first.'
}

$commandArgs = @('-m', 'scripts.wikipedia_word2vec', $Stage)
if ($Dump) { $commandArgs += @('--input', $Dump) }
if ($Corpus) { $commandArgs += @('--corpus', $Corpus) }
if ($Output) { $commandArgs += @('--output', $Output) }
$commandArgs += @(
    '--max-articles', $MaxArticles,
    '--vector-size', $VectorSize,
    '--max-vocab', $MaxVocabulary,
    '--min-count', $MinCount,
    '--epochs', $Epochs,
    '--workers', $Workers
)
if ($Force) { $commandArgs += '--force' }

$env:PYTHONIOENCODING = 'utf-8'
& $pythonExe @commandArgs
exit $LASTEXITCODE
