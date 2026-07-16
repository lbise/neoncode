param(
    [ValidateSet("bootstrap", "install", "publish", "start", "status", "stop")]
    [string]$Command = "start",
    [string]$OutputPath = "$env:USERPROFILE\neoncode-electron",
    [int]$TerminalCount = 2,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

function Resolve-Npm {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd" }
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        throw "npm.cmd not found. Install Node.js for Windows."
    }
    $env:PATH = "$(Split-Path -Parent $npm);$env:PATH"
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
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

function Stop-ElectronAppProcesses {
    param([Parameter(Mandatory=$true)][string]$PublishedDirectory)
    $expectedPath = Join-Path $PublishedDirectory "node_modules\electron\dist\electron.exe"
    Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ([string]::Equals($_.Path, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) } |
        Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

function Copy-PackageManifests {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory
    )
    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    foreach ($name in @("package.json", "package-lock.json")) {
        Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination (Join-Path $DestinationDirectory $name) -Force
    }
}

function Copy-AppArtifacts {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory
    )
    $sourceDist = Join-Path $SourceDirectory "dist"
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDist "main.js") -PathType Leaf)) {
        throw "Generated Electron artifacts are missing. Run 'npm --prefix frontends/electron run build' first."
    }
    Copy-PackageManifests -SourceDirectory $SourceDirectory -DestinationDirectory $DestinationDirectory
    foreach ($name in @("index.html", "styles.css")) {
        Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination (Join-Path $DestinationDirectory $name) -Force
    }
    $destinationDist = Join-Path $DestinationDirectory "dist"
    if (Test-Path -LiteralPath $destinationDist) { Remove-Item -LiteralPath $destinationDist -Recurse -Force }
    Copy-Item -LiteralPath $sourceDist -Destination $destinationDist -Recurse -Force
}

function Get-ExpectedRuntimeIdentity {
    param([Parameter(Mandatory=$true)][string]$SourceDirectory)
    $package = Get-Content -LiteralPath (Join-Path $SourceDirectory "package.json") -Raw | ConvertFrom-Json
    $architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
        "ARM64" { "arm64" }
        "AMD64" { "x64" }
        "x86" { "ia32" }
        default { $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant() }
    }
    return [ordered]@{
        packageLockSha256 = (Get-FileHash -LiteralPath (Join-Path $SourceDirectory "package-lock.json") -Algorithm SHA256).Hash
        electronVersion = [string]$package.devDependencies.electron
        platform = "win32"
        architecture = $architecture
    }
}

function Get-RuntimeStatus {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$PublishedDirectory
    )
    $expected = Get-ExpectedRuntimeIdentity -SourceDirectory $SourceDirectory
    $markerPath = Join-Path $PublishedDirectory ".neoncode-runtime.json"
    $electronBin = Join-Path $PublishedDirectory "node_modules\electron\dist\electron.exe"
    $marker = $null
    $markerError = $null
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json }
        catch { $markerError = $_.Exception.Message }
    }
    $executableHash = $null
    if (Test-Path -LiteralPath $electronBin -PathType Leaf) {
        try { $executableHash = (Get-FileHash -LiteralPath $electronBin -Algorithm SHA256).Hash }
        catch { $markerError = "could not hash electron.exe: $($_.Exception.Message)" }
    }
    $markerMatches = $marker -and
        $marker.schemaVersion -eq 1 -and
        $marker.packageLockSha256 -eq $expected.packageLockSha256 -and
        $marker.electronVersion -eq $expected.electronVersion -and
        $marker.platform -eq $expected.platform -and
        $marker.architecture -eq $expected.architecture -and
        $marker.executableSha256 -eq $executableHash
    return [pscustomobject]@{
        Expected = $expected
        Marker = $marker
        MarkerPath = $markerPath
        MarkerError = $markerError
        MarkerMatches = [bool]$markerMatches
        ElectronPath = $electronBin
        ExecutablePresent = Test-Path -LiteralPath $electronBin -PathType Leaf
        ExecutableSha256 = $executableHash
    }
}

function Write-RuntimeMarker {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$PublishedDirectory
    )
    $status = Get-RuntimeStatus -SourceDirectory $SourceDirectory -PublishedDirectory $PublishedDirectory
    if (-not $status.ExecutablePresent -or -not $status.ExecutableSha256) {
        throw "Electron runtime installation did not produce a readable electron.exe. Defender may have quarantined it."
    }
    $marker = [ordered]@{
        schemaVersion = 1
        packageLockSha256 = $status.Expected.packageLockSha256
        electronVersion = $status.Expected.electronVersion
        platform = $status.Expected.platform
        architecture = $status.Expected.architecture
        executableSha256 = $status.ExecutableSha256
        createdAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    $marker | ConvertTo-Json | Set-Content -LiteralPath $status.MarkerPath -Encoding UTF8
}

function Assert-RuntimeReady {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$PublishedDirectory
    )
    $status = Get-RuntimeStatus -SourceDirectory $SourceDirectory -PublishedDirectory $PublishedDirectory
    if (-not $status.MarkerMatches) {
        throw "Stable Electron runtime is missing or does not match package-lock.json. Run './dev electron-bootstrap'. Normal publish will not reinstall executables."
    }
    return $status
}

function Show-RuntimeStatus {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$PublishedDirectory
    )
    $status = Get-RuntimeStatus -SourceDirectory $SourceDirectory -PublishedDirectory $PublishedDirectory
    Write-Host "Electron runtime status"
    Write-Host "  Path:             $($status.ElectronPath)"
    Write-Host "  Expected version: $($status.Expected.electronVersion)"
    Write-Host "  Lock SHA-256:     $($status.Expected.packageLockSha256)"
    Write-Host "  Executable:       $(if ($status.ExecutablePresent) { 'present' } else { 'missing' })"
    Write-Host "  Executable hash:  $($status.ExecutableSha256)"
    Write-Host "  Marker matches:   $($status.MarkerMatches)"
    if ($status.MarkerError) { Write-Host "  Marker/error:     $($status.MarkerError)" }
    if ($status.ExecutablePresent) {
        $signature = Get-AuthenticodeSignature -LiteralPath $status.ElectronPath
        Write-Host "  Authenticode:     $($signature.Status)"
    }
    if (-not $status.MarkerMatches) { exit 3 }
    try {
        $versionOutput = & $status.ElectronPath --version 2>&1
        if ($null -eq $LASTEXITCODE) {
            throw "Windows refused to start electron.exe and returned no exit code (commonly a Defender or application-control block)"
        }
        if ($LASTEXITCODE -ne 0) { throw "electron.exe exited with $LASTEXITCODE`: $($versionOutput -join ' ')" }
        Write-Host "  Execution probe:  passed ($versionOutput)"
    } catch {
        Write-Host "  Execution probe:  BLOCKED"
        Write-Host "  Detail:           $($_.Exception.Message)"
        Write-Host ""
        Write-Host "The runtime hash is verified, but Windows refused execution. On a managed"
        Write-Host "endpoint, collect this output and request an IT/Microsoft Defender hash"
        Write-Host "allow-indicator or false-positive review. Do not disable Defender."
        exit 4
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = (Resolve-Path -LiteralPath (Join-Path $repoRoot "frontends\electron")).ProviderPath
$publishedDir = Join-Path $OutputPath "electron"

switch ($Command) {
    { $_ -in @("bootstrap", "install") } {
        Stop-ElectronAppProcesses -PublishedDirectory $publishedDir
        New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
        Copy-PackageManifests -SourceDirectory $sourceDir -DestinationDirectory $publishedDir
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "ci"
        Invoke-Npm -WorkingDirectory $publishedDir -Arguments "exec -- install-electron"
        Write-RuntimeMarker -SourceDirectory $sourceDir -PublishedDirectory $publishedDir
        Write-Host "Stable Electron runtime bootstrapped. Ordinary publish will preserve it."
    }

    "publish" {
        Stop-ElectronAppProcesses -PublishedDirectory $publishedDir
        $null = Assert-RuntimeReady -SourceDirectory $sourceDir -PublishedDirectory $publishedDir
        if ($Clean) { Write-Host "Cleaning generated app artifacts while preserving the stable Electron runtime." }
        Copy-AppArtifacts -SourceDirectory $sourceDir -DestinationDirectory $publishedDir
        foreach ($required in @(
            (Join-Path $publishedDir "dist\main.js"),
            (Join-Path $publishedDir "dist\preload.js"),
            (Join-Path $publishedDir "dist\renderer.bundle.js"),
            (Join-Path $publishedDir "index.html"),
            (Join-Path $publishedDir "styles.css")
        )) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
                throw "Published Electron app file missing: $required"
            }
        }
        Write-Host "Electron app artifacts published without reinstalling the runtime."
        Write-Host "Output: $OutputPath"
    }

    "status" {
        Show-RuntimeStatus -SourceDirectory $sourceDir -PublishedDirectory $publishedDir
    }

    "start" {
        Stop-ElectronAppProcesses -PublishedDirectory $publishedDir
        $status = Assert-RuntimeReady -SourceDirectory $sourceDir -PublishedDirectory $publishedDir
        if (-not (Test-Path -LiteralPath (Join-Path $publishedDir "dist\main.js"))) {
            throw "Published app artifacts are missing. Run './dev publish' first."
        }
        if ($PSBoundParameters.ContainsKey("TerminalCount")) {
            Write-Warning "TerminalCount is ignored by the detached medium-integrity launcher; edit config.json instead."
        }
        $shortcutPath = Join-Path $OutputPath "NeonCode Dev.lnk"
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $status.ElectronPath
        $shortcut.Arguments = "`"$publishedDir`""
        $shortcut.WorkingDirectory = $publishedDir
        $shortcut.Save()
        Start-Process explorer.exe -ArgumentList "`"$shortcutPath`""
        Write-Host "Started published NeonCode Electron app through Explorer."
    }

    "stop" {
        Stop-ElectronAppProcesses -PublishedDirectory $publishedDir
        Write-Host "Stopped published NeonCode Electron processes."
    }
}
