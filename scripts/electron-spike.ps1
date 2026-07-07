param(
    [ValidateSet("install", "start", "build-native")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$spikeDir = Join-Path $repoRoot "spikes\electron-native-terminal\electron"
$spikeDir = (Resolve-Path -LiteralPath $spikeDir).ProviderPath

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
    $npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
}

if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
    throw "npm.cmd not found. Install Node.js for Windows."
}

$nodeDir = Split-Path -Parent $npm
$env:PATH = "$nodeDir;$env:PATH"

switch ($Command) {
    "install" { $npmArgs = "install" }
    "start" { $npmArgs = "start" }
    "build-native" { $npmArgs = "run build-native" }
}

Write-Host "Electron spike directory: $spikeDir"
Write-Host "npm: $npm"
Write-Host "Command: npm.cmd $npmArgs"

# npm.cmd is a batch file. cmd.exe cannot use a UNC path as its working directory,
# so use pushd, which maps UNC paths to a temporary drive automatically.
$cmd = "pushd `"$spikeDir`" && `"$npm`" $npmArgs"
Push-Location $env:TEMP
try {
    & cmd.exe /d /s /c $cmd
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
