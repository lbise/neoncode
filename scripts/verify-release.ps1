[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [string]$ManifestPath,
    [switch]$RequireSigning,
    [switch]$SkipDefender,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
}

function Resolve-ReleaseDirectory {
    param([string]$Directory)
    $candidate = if ($Directory) {
        $Directory
    } else {
        $repoRoot = Resolve-RepoRoot
        Join-Path $repoRoot "release\windows-alpha"
    }
    if ($DryRun -and -not (Test-Path -LiteralPath $candidate)) {
        return $candidate
    }
    return (Resolve-Path -LiteralPath $candidate).ProviderPath
}

function Get-RelativePathFromBase {
    param(
        [Parameter(Mandatory=$true)][string]$BaseDirectory,
        [Parameter(Mandatory=$true)][string]$Path
    )
    $base = (Resolve-Path -LiteralPath $BaseDirectory).ProviderPath.TrimEnd('\') + '\'
    $target = (Resolve-Path -LiteralPath $Path).ProviderPath
    $baseUri = [Uri]::new($base)
    $targetUri = [Uri]::new($target)
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function Assert-HashFile {
    param([Parameter(Mandatory=$true)][string]$Directory)
    $sumsPath = Join-Path $Directory "SHA256SUMS"
    if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
        throw "SHA256SUMS is missing: $sumsPath"
    }
    foreach ($line in Get-Content -LiteralPath $sumsPath) {
        if (-not $line.Trim()) { continue }
        if ($line -notmatch '^([0-9A-Fa-f]{64})\s+\*?(.+)$') {
            throw "Malformed SHA256SUMS line: $line"
        }
        $expected = $Matches[1].ToUpperInvariant()
        $relative = $Matches[2].Trim()
        $artifactPath = Join-Path $Directory $relative
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "SHA256SUMS references a missing file: $relative"
        }
        $actual = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actual -ne $expected) {
            throw "SHA256 mismatch for $relative`: expected $expected, got $actual"
        }
        Write-Host "hash ok: $relative"
    }
}

function Assert-Manifest {
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "release manifest is missing: $Path"
    }
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1) { throw "Unsupported release manifest schema: $($manifest.schemaVersion)" }
    if ($manifest.channel -ne "alpha") { throw "Release manifest channel is not alpha: $($manifest.channel)" }
    foreach ($artifact in @($manifest.artifacts)) {
        $artifactPath = Join-Path $Directory ([string]$artifact.path)
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "Manifest references a missing artifact: $($artifact.path)"
        }
        $actual = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToUpperInvariant()
        $expected = ([string]$artifact.sha256).ToUpperInvariant()
        if ($actual -ne $expected) {
            throw "Manifest hash mismatch for $($artifact.path): expected $expected, got $actual"
        }
        Write-Host "manifest ok: $($artifact.path)"
    }
    return $manifest
}

function Get-SignableArtifacts {
    param([Parameter(Mandatory=$true)][string]$Directory)
    Get-ChildItem -LiteralPath $Directory -Recurse -File |
        Where-Object { $_.Extension -in @('.exe', '.msi', '.msix', '.appx') } |
        Sort-Object FullName
}

function Assert-AuthenticodeSignatures {
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][bool]$Required
    )
    $signable = @(Get-SignableArtifacts -Directory $Directory)
    if ($signable.Count -eq 0) {
        if ($Required) { throw "Signing is required but no signable release artifacts were found." }
        Write-Warning "No signable release artifacts found."
        return
    }
    foreach ($artifact in $signable) {
        $relative = Get-RelativePathFromBase -BaseDirectory $Directory -Path $artifact.FullName
        $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
        Write-Host "signature: $relative $($signature.Status)"
        if ($Required -and $signature.Status -ne 'Valid') {
            throw "Signing is required but $relative has Authenticode status $($signature.Status)."
        }
    }
}

function Invoke-DefenderScan {
    param([Parameter(Mandatory=$true)][string]$Directory)
    if ($SkipDefender) {
        Write-Host "Defender scan skipped by request."
        return
    }
    if ($DryRun) {
        Write-Host "DRY RUN: would run Microsoft Defender scan for $Directory"
        return
    }
    $startMpScan = Get-Command Start-MpScan -ErrorAction SilentlyContinue
    if ($startMpScan) {
        Write-Host "Running Microsoft Defender custom scan with Start-MpScan."
        Start-MpScan -ScanPath $Directory -ScanType CustomScan
        return
    }
    $mpCmdRunCandidates = @(
        Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe",
        Join-Path ${env:ProgramFiles(x86)} "Windows Defender\MpCmdRun.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $mpCmdRun = $mpCmdRunCandidates | Select-Object -First 1
    if ($mpCmdRun) {
        Write-Host "Running Microsoft Defender custom scan with MpCmdRun.exe."
        & $mpCmdRun -Scan -ScanType 3 -File $Directory
        if ($LASTEXITCODE -ne 0) { throw "Microsoft Defender scan failed with exit code $LASTEXITCODE." }
        return
    }
    Write-Warning "Microsoft Defender scan tooling is not available on this host. No exclusions were requested or applied."
}

$releaseDir = Resolve-ReleaseDirectory -Directory $ReleaseDirectory
$manifest = if ($ManifestPath) {
    (Resolve-Path -LiteralPath $ManifestPath).ProviderPath
} else {
    Join-Path $releaseDir "manifest.json"
}

Write-Host "Verifying NeonCode alpha release artifacts"
Write-Host "  Release directory: $releaseDir"
Write-Host "  Manifest:          $manifest"
Write-Host "  Signing required:  $([bool]$RequireSigning)"

if ($DryRun) {
    Write-Host "DRY RUN: would verify hashes, manifest, Authenticode signatures, and Defender scan."
    exit 0
}

Assert-HashFile -Directory $releaseDir
$null = Assert-Manifest -Directory $releaseDir -Path $manifest
Assert-AuthenticodeSignatures -Directory $releaseDir -Required ([bool]$RequireSigning)
Invoke-DefenderScan -Directory $releaseDir
Write-Host "Release verification passed."
