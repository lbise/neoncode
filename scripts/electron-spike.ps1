param(
    [ValidateSet("install", "start", "build-native", "build-coordinator", "publish")]
    [string]$Command = "start",
    [string]$OutputPath = "$env:USERPROFILE\neoncode-electron-spike",
    [ValidateSet("wpf", "coordinator")]
    [string]$HostKind = "wpf",
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

    # npm.cmd is a batch file. cmd.exe cannot use a UNC path as its working directory,
    # so use pushd, which maps UNC paths to a temporary drive automatically. For the
    # published spike this is still harmless because the path is Windows-local.
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

function Resolve-MSBuild {
    $msbuild = (Get-Command msbuild.exe -ErrorAction SilentlyContinue).Source
    if ($msbuild) {
        return $msbuild
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $installPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
        if ($installPath) {
            $candidate = Join-Path $installPath "MSBuild\Current\Bin\MSBuild.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    throw "MSBuild.exe not found. Install Visual Studio Build Tools with MSBuild and C++ workload."
}

function Stop-SpikeProcesses {
    Get-Process NeonCode.ElectronTerminalHost -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process NeonCode.NativeTerminalCoordinator -ErrorAction SilentlyContinue | Stop-Process -Force
    # Spike-only helper: stop Electron aggressively so publish can replace
    # electron.exe/node_modules even when process metadata is restricted by IT
    # policy and Path is unavailable.
    Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

function Copy-SpikeElectronFiles {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory
    )

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null

    foreach ($file in @("package.json", "package-lock.json", "main.js", "index.html", "styles.css")) {
        $source = Join-Path $SourceDirectory $file
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationDirectory $file) -Force
        }
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceElectronDir = (Resolve-Path -LiteralPath (Join-Path $repoRoot "spikes\electron-native-terminal\electron")).ProviderPath
$nativeProject = (Resolve-Path -LiteralPath (Join-Path $repoRoot "spikes\electron-native-terminal\native\NeonCode.ElectronTerminalHost\NeonCode.ElectronTerminalHost.csproj")).ProviderPath
$nativeCoordinatorProject = (Resolve-Path -LiteralPath (Join-Path $repoRoot "spikes\electron-native-terminal\native\NeonCode.NativeTerminalCoordinator\NeonCode.NativeTerminalCoordinator.vcxproj")).ProviderPath
$nativeCoordinatorDir = Split-Path -Parent $nativeCoordinatorProject
$nativeCoordinatorExe = Join-Path $nativeCoordinatorDir "bin\x64\Debug\NeonCode.NativeTerminalCoordinator.exe"
$publishedElectronDir = Join-Path $OutputPath "electron"
$publishedNativeHostDir = Join-Path $OutputPath "native-host"

switch ($Command) {
    "build-native" {
        Write-Host "Building Electron spike WPF native host"
        & dotnet build $nativeProject -v:minimal
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }

        Write-Host "Building Electron spike direct native coordinator"
        $msbuild = Resolve-MSBuild
        & $msbuild $nativeCoordinatorProject /p:Configuration=Debug /p:Platform=x64 /m /v:minimal
        exit $LASTEXITCODE
    }

    "build-coordinator" {
        Write-Host "Building Electron spike direct native coordinator"
        $msbuild = Resolve-MSBuild
        & $msbuild $nativeCoordinatorProject /p:Configuration=Debug /p:Platform=x64 /m /v:minimal
        exit $LASTEXITCODE
    }

    "install" {
        Invoke-Npm -WorkingDirectory $sourceElectronDir -Arguments "install"
    }

    "publish" {
        Stop-SpikeProcesses

        if ($Clean -and (Test-Path -LiteralPath $OutputPath)) {
            Write-Host "Cleaning Electron spike output: $OutputPath"
            Remove-Item -LiteralPath $OutputPath -Recurse -Force
        }

        New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null

        Write-Host "Publishing WPF native terminal host to: $publishedNativeHostDir"
        & dotnet publish $nativeProject -c Debug -o $publishedNativeHostDir -v:minimal
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }

        Write-Host "Building direct native terminal coordinator"
        $msbuild = Resolve-MSBuild
        & $msbuild $nativeCoordinatorProject /p:Configuration=Debug /p:Platform=x64 /m /v:minimal
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }

        Copy-Item -LiteralPath $nativeCoordinatorExe -Destination (Join-Path $publishedNativeHostDir "NeonCode.NativeTerminalCoordinator.exe") -Force

        Write-Host "Copying Electron shell to: $publishedElectronDir"
        Copy-SpikeElectronFiles -SourceDirectory $sourceElectronDir -DestinationDirectory $publishedElectronDir

        Invoke-Npm -WorkingDirectory $publishedElectronDir -Arguments "install"

        $hostExe = Join-Path $publishedNativeHostDir "NeonCode.ElectronTerminalHost.exe"
        $coordinatorExe = Join-Path $publishedNativeHostDir "NeonCode.NativeTerminalCoordinator.exe"
        $packageJson = Join-Path $publishedElectronDir "package.json"
        $electronBin = Join-Path $publishedElectronDir "node_modules\electron\dist\electron.exe"

        foreach ($required in @($hostExe, $coordinatorExe, $packageJson, $electronBin)) {
            if (-not (Test-Path -LiteralPath $required)) {
                throw "Published Electron spike file missing: $required"
            }
        }

        Write-Host ""
        Write-Host "Electron spike publish succeeded."
        Write-Host "Output: $OutputPath"
        Write-Host "Run:"
        Write-Host "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\electron-spike.ps1 -Command start"
    }

    "start" {
        Stop-SpikeProcesses

        if (-not (Test-Path -LiteralPath (Join-Path $publishedElectronDir "package.json"))) {
            throw "Published Electron spike not found at $OutputPath. Run './dev electron-spike-publish' first."
        }

        $env:NEONCODE_TERMINAL_HOST_KIND = $HostKind
        Write-Host "Terminal host kind: $env:NEONCODE_TERMINAL_HOST_KIND"
        Invoke-Npm -WorkingDirectory $publishedElectronDir -Arguments "start"
    }
}
