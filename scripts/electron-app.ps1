param(
    [ValidateSet("install", "publish", "start")]
    [string]$Command = "start",
    [string]$OutputPath = "$env:USERPROFILE\neoncode-electron",
    [int]$TerminalCount = 2,
    [switch]$Clean
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

function Invoke-Npm {
    param(
        [Parameter(Mandatory=$true)][string]$WorkingDirectory,
        [Parameter(Mandatory=$true)][string]$Arguments
    )

    $npm = Resolve-Npm
    Write-Host "npm: $npm"
    Write-Host "Working directory: $WorkingDirectory"
    Write-Host "Command: npm.cmd $Arguments"

    $cmd = "pushd `"$WorkingDirectory`" && `"$npm`" $Arguments"
    Push-Location $env:TEMP
    try {
        & cmd.exe /d /s /c $cmd
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

function Stop-ElectronAppProcesses {
    Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

function Copy-ElectronAppFiles {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory
    )

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    foreach ($file in @("package.json", "package-lock.json", "main.js", "preload.js", "index.html", "styles.css", "renderer.js")) {
        $source = Join-Path $SourceDirectory $file
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationDirectory $file) -Force
        }
    }

    foreach ($directory in @("renderer", "tests")) {
        $source = Join-Path $SourceDirectory $directory
        if (Test-Path -LiteralPath $source -PathType Container) {
            $destination = Join-Path $DestinationDirectory $directory
            if (Test-Path -LiteralPath $destination) {
                Remove-Item -LiteralPath $destination -Recurse -Force
            }
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = (Resolve-Path -LiteralPath (Join-Path $repoRoot "frontends\electron")).ProviderPath
$publishedDir = Join-Path $OutputPath "electron"

switch ($Command) {
    "install" {
        Invoke-Npm -WorkingDirectory $sourceDir -Arguments "install"
    }

    "publish" {
        Stop-ElectronAppProcesses

        if ($Clean -and (Test-Path -LiteralPath $OutputPath)) {
            Write-Host "Cleaning Electron app output: $OutputPath"
            Remove-Item -LiteralPath $OutputPath -Recurse -Force
        }

        New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
        Write-Host "Copying Electron app to: $publishedDir"
        Copy-ElectronAppFiles -SourceDirectory $sourceDir -DestinationDirectory $publishedDir
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "ci"
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "exec -- install-electron"
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "run build:renderer"

        $packageJson = Join-Path $publishedDir "package.json"
        $electronBin = Join-Path $publishedDir "node_modules\electron\dist\electron.exe"
        $preload = Join-Path $publishedDir "preload.js"
        $rendererBundle = Join-Path $publishedDir "renderer.bundle.js"
        $xtermPackage = Join-Path $publishedDir "node_modules\@xterm\xterm\package.json"
        $fitPackage = Join-Path $publishedDir "node_modules\@xterm\addon-fit\package.json"

        foreach ($required in @($packageJson, $electronBin, $preload, $rendererBundle, $xtermPackage, $fitPackage)) {
            if (-not (Test-Path -LiteralPath $required)) {
                throw "Published Electron app file missing: $required"
            }
        }

        Write-Host ""
        Write-Host "Electron app publish succeeded."
        Write-Host "Output: $OutputPath"
        Write-Host "Run:"
        Write-Host "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\electron-app.ps1 -Command start"
    }

    "start" {
        Stop-ElectronAppProcesses

        if (-not (Test-Path -LiteralPath (Join-Path $publishedDir "package.json"))) {
            throw "Published Electron app not found at $OutputPath. Run './dev publish' first."
        }

        $env:NEONCODE_TERMINAL_COUNT = [string]$TerminalCount
        Write-Host "Terminal count: $env:NEONCODE_TERMINAL_COUNT"
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "start"
    }
}
