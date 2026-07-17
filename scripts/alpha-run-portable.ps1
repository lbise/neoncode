[CmdletBinding()]
param(
    [string]$WslRepoPath,
    [string]$ReleaseDirectory,
    [string]$InstallDirectory,
    [switch]$SkipBuild,
    [switch]$SkipVerify,
    [switch]$SkipDefender,
    [switch]$RequireSigning,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
}

function Resolve-DefaultReleaseDirectory {
    $repoRoot = Resolve-RepoRoot
    return (Join-Path $repoRoot "release\windows-alpha")
}

function Resolve-DefaultInstallDirectory {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localAppData) { throw "LOCALAPPDATA is unavailable; cannot choose a dogfood install directory." }
    return (Join-Path $localAppData "NeonCodeAlpha")
}

function Get-PortableArtifact {
    param([Parameter(Mandatory=$true)][string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }
    $matches = @(
        Get-ChildItem -LiteralPath $Directory -File -Filter "*alpha-portable-*.exe" |
            Sort-Object LastWriteTimeUtc -Descending
    )
    if ($matches.Count -eq 0) { return $null }
    return $matches[0]
}

function Invoke-ReleaseBuildIfNeeded {
    param(
        [Parameter(Mandatory=$true)][string]$ReleaseDir,
        [string]$RepoPath
    )
    if ($SkipBuild) { return }
    if (Get-PortableArtifact -Directory $ReleaseDir) { return }
    if (-not $RepoPath) {
        throw "No alpha portable artifact found in $ReleaseDir and WslRepoPath was not supplied for building."
    }
    Write-Host "Alpha portable artifact was not found; building alpha release first."
    $releaseScript = Join-Path $PSScriptRoot "release-windows.ps1"
    $releaseArgs = @('-WslRepoPath', $RepoPath)
    if ($SkipDefender) { $releaseArgs += '-SkipDefender' }
    if ($RequireSigning) { $releaseArgs += '-RequireSigning' }
    if ($DryRun) { $releaseArgs += '-DryRun' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $releaseScript @releaseArgs
    if ($LASTEXITCODE -ne 0) { throw "Alpha release build failed with exit code $LASTEXITCODE." }
}

function Invoke-ReleaseVerification {
    param([Parameter(Mandatory=$true)][string]$ReleaseDir)
    if ($SkipVerify) {
        Write-Host "Release verification skipped by request."
        return
    }
    $verifyScript = Join-Path $PSScriptRoot "verify-release.ps1"
    $verifyArgs = @('-ReleaseDirectory', $ReleaseDir)
    if ($SkipDefender) { $verifyArgs += '-SkipDefender' }
    if ($RequireSigning) { $verifyArgs += '-RequireSigning' }
    if ($DryRun) { $verifyArgs += '-DryRun' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw "Alpha release verification failed with exit code $LASTEXITCODE." }
}

function Copy-DogfoodArtifact {
    param(
        [Parameter(Mandatory=$true)]$Artifact,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory
    )
    $stablePath = Join-Path $DestinationDirectory "NeonCodeAlpha.exe"
    if ($DryRun) {
        Write-Host "DRY RUN: would copy $($Artifact.FullName) to $stablePath and unblock the local copy."
        return $stablePath
    }
    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    $versionedPath = Join-Path $DestinationDirectory $Artifact.Name
    Copy-Item -LiteralPath $Artifact.FullName -Destination $versionedPath -Force
    Copy-Item -LiteralPath $Artifact.FullName -Destination $stablePath -Force

    foreach ($path in @($versionedPath, $stablePath)) {
        try {
            Unblock-File -LiteralPath $path -ErrorAction Stop
            Write-Host "Unblocked local dogfood artifact: $path"
        } catch {
            Write-Warning "Could not unblock $path`: $($_.Exception.Message)"
        }
    }

    $metadata = [ordered]@{
        source = $Artifact.FullName
        copiedAtUtc = [DateTime]::UtcNow.ToString('o')
        sha256 = (Get-FileHash -LiteralPath $stablePath -Algorithm SHA256).Hash.ToUpperInvariant()
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DestinationDirectory "dogfood.json") -Encoding UTF8
    return $stablePath
}

function Start-WithExplorer {
    param([Parameter(Mandatory=$true)][string]$ExecutablePath)
    if ($DryRun) {
        Write-Host "DRY RUN: would launch NeonCode Alpha through Explorer: $ExecutablePath"
        return
    }
    Write-Host "Launching NeonCode Alpha through Explorer: $ExecutablePath"
    & explorer.exe $ExecutablePath
}

$releaseDir = if ($ReleaseDirectory) { $ReleaseDirectory } else { Resolve-DefaultReleaseDirectory }
$installDir = if ($InstallDirectory) { $InstallDirectory } else { Resolve-DefaultInstallDirectory }

Invoke-ReleaseBuildIfNeeded -ReleaseDir $releaseDir -RepoPath $WslRepoPath
$artifact = Get-PortableArtifact -Directory $releaseDir
if (-not $artifact) {
    throw "No alpha portable artifact found in $releaseDir. Run './dev release-alpha' first."
}

Invoke-ReleaseVerification -ReleaseDir $releaseDir
$localExecutable = Copy-DogfoodArtifact -Artifact $artifact -DestinationDirectory $installDir
Start-WithExplorer -ExecutablePath $localExecutable
Write-Host "NeonCode Alpha dogfood executable: $localExecutable"
