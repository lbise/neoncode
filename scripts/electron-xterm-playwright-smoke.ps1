param(
    [string]$OutputPath = "$env:USERPROFILE\neoncode-electron-xterm-spike",
    [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Resolve-Npm {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) {
        $npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
    }

    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        throw "npm.cmd not found. Install Node.js for Windows."
    }

    $nodeDir = Split-Path -Parent $npm
    $env:PATH = "$nodeDir;$env:PATH"
    return $npm
}

$publishedDir = Join-Path $OutputPath "electron"
$packageJson = Join-Path $publishedDir "package.json"
$testScript = Join-Path $publishedDir "tests\electron-smoke.js"
$playwrightPackage = Join-Path $publishedDir "node_modules\playwright\package.json"

foreach ($required in @($packageJson, $testScript, $playwrightPackage)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required xterm Playwright smoke file missing: $required. Run './dev publish' first."
    }
}

$npm = Resolve-Npm
$env:NEONCODE_PLAYWRIGHT_TIMEOUT = [string]($TimeoutSeconds * 1000)
Write-Host "npm: $npm"
Write-Host "Working directory: $publishedDir"
Write-Host "Command: npm.cmd run smoke"

$cmd = "pushd `"$publishedDir`" && `"$npm`" run smoke"
Push-Location $env:TEMP
try {
    & cmd.exe /d /s /c $cmd
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
