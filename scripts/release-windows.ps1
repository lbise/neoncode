[CmdletBinding()]
param(
    [string]$WslRepoPath,
    [string]$OutputDirectory,
    [switch]$SkipRustBuild,
    [switch]$SkipElectronBuild,
    [switch]$SkipPackage,
    [switch]$SkipVerify,
    [switch]$RequireSigning,
    [switch]$SkipDefender,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
}

function ConvertTo-ReleaseBool {
    param([string]$Value)
    return $Value -match '^(1|true|yes)$'
}

function Assert-WslRepoPath {
    param([string]$Path)
    if ($Path) { return $Path }
    throw "WslRepoPath is required. From WSL use './dev release-alpha', which passes the current repo path."
}

function Invoke-WslCommand {
    param(
        [Parameter(Mandatory=$true)][string]$RepoPath,
        [Parameter(Mandatory=$true)][string]$Command,
        [switch]$Capture
    )
    Write-Host "WSL> $Command"
    if ($DryRun) {
        if ($Capture) { return "" }
        return
    }
    if ($Capture) {
        $output = & wsl.exe --cd $RepoPath --exec bash -lc $Command
        if ($LASTEXITCODE -ne 0) { throw "WSL command failed with exit code $LASTEXITCODE`: $Command" }
        return ($output -join "`n").Trim()
    }
    & wsl.exe --cd $RepoPath --exec bash -lc $Command
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed with exit code $LASTEXITCODE`: $Command" }
}

function Get-SigningCertificate {
    $thumbprint = [string]$env:SIGNING_CERT_THUMBPRINT
    $subject = [string]$env:SIGNING_CERT_SUBJECT
    if ($thumbprint) {
        $normalized = $thumbprint -replace '\s', ''
        $matches = @(
            Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $normalized }
        )
        if ($matches.Count -eq 0) { throw "SIGNING_CERT_THUMBPRINT was set but no matching certificate was found: $thumbprint" }
        return $matches | Sort-Object NotAfter -Descending | Select-Object -First 1
    }
    if ($subject) {
        $matches = @(
            Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
                Where-Object { $_.Subject -like "*$subject*" }
        )
        if ($matches.Count -eq 0) { throw "SIGNING_CERT_SUBJECT was set but no matching certificate subject was found: $subject" }
        return $matches | Sort-Object NotAfter -Descending | Select-Object -First 1
    }
    return $null
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

function Get-ReleaseArtifacts {
    param([Parameter(Mandatory=$true)][string]$Directory)
    Get-ChildItem -LiteralPath $Directory -Recurse -File |
        Where-Object { $_.Name -notin @('SHA256SUMS', 'manifest.json') } |
        Sort-Object FullName
}

function Get-SignableArtifacts {
    param([Parameter(Mandatory=$true)][string]$Directory)
    Get-ReleaseArtifacts -Directory $Directory |
        Where-Object { $_.Extension -in @('.exe', '.msi', '.msix', '.appx') }
}

function Invoke-AuthenticodeSigning {
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][bool]$Required
    )
    $certificate = Get-SigningCertificate
    if (-not $certificate) {
        if ($Required) {
            throw "Signing is required but neither SIGNING_CERT_THUMBPRINT nor SIGNING_CERT_SUBJECT resolved to a certificate."
        }
        Write-Host "Signing skipped: SIGNING_CERT_THUMBPRINT/SIGNING_CERT_SUBJECT not set."
        return $null
    }
    $signable = @(Get-SignableArtifacts -Directory $Directory)
    if ($signable.Count -eq 0) {
        if ($Required) { throw "Signing is required but no signable artifacts were produced." }
        Write-Warning "No signable artifacts found to sign."
        return $certificate
    }
    foreach ($artifact in $signable) {
        $relative = Get-RelativePathFromBase -BaseDirectory $Directory -Path $artifact.FullName
        Write-Host "Signing $relative with $($certificate.Subject)"
        if ($DryRun) { continue }
        $parameters = @{
            LiteralPath = $artifact.FullName
            Certificate = $certificate
            HashAlgorithm = 'SHA256'
        }
        if ($env:SIGNING_TIMESTAMP_URL) { $parameters.TimestampServer = [string]$env:SIGNING_TIMESTAMP_URL }
        $signature = Set-AuthenticodeSignature @parameters
        if ($signature.Status -ne 'Valid') {
            throw "Authenticode signing failed for $relative`: $($signature.Status) $($signature.StatusMessage)"
        }
    }
    return $certificate
}

function Write-ReleaseInfo {
    param(
        [Parameter(Mandatory=$true)][string]$RepoPath,
        [Parameter(Mandatory=$true)][string]$Version,
        [Parameter(Mandatory=$true)][string]$GitSha
    )
    $json = [ordered]@{
        schemaVersion = 1
        product = 'NeonCode'
        channel = 'alpha'
        version = $Version
        gitSha = $GitSha
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    Invoke-WslCommand -RepoPath $RepoPath -Command "printf '%s' '$encoded' | base64 -d > frontends/electron/dist/release-info.json"
}

function Write-ReleaseManifestAndHashes {
    param(
        [Parameter(Mandatory=$true)][string]$Directory,
        [Parameter(Mandatory=$true)][string]$Version,
        [Parameter(Mandatory=$true)][string]$GitSha,
        [Parameter(Mandatory=$true)][bool]$SigningRequired,
        $Certificate
    )
    if ($DryRun) {
        Write-Host "DRY RUN: would generate SHA256SUMS and manifest.json in $Directory"
        return
    }
    $artifacts = @(Get-ReleaseArtifacts -Directory $Directory)
    if ($artifacts.Count -eq 0) { throw "No release artifacts were produced in $Directory" }
    $sumLines = New-Object System.Collections.Generic.List[string]
    $manifestArtifacts = New-Object System.Collections.Generic.List[object]
    foreach ($artifact in $artifacts) {
        $relative = Get-RelativePathFromBase -BaseDirectory $Directory -Path $artifact.FullName
        $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
        $signature = $null
        if ($artifact.Extension -in @('.exe', '.msi', '.msix', '.appx')) {
            $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
        }
        $sumLines.Add("$hash  $relative")
        $manifestArtifacts.Add([ordered]@{
            path = $relative
            name = $artifact.Name
            bytes = $artifact.Length
            sha256 = $hash
            authenticodeStatus = if ($signature) { [string]$signature.Status } else { $null }
        })
    }
    $sumLines | Set-Content -LiteralPath (Join-Path $Directory "SHA256SUMS") -Encoding ASCII
    $manifest = [ordered]@{
        schemaVersion = 1
        product = 'NeonCode'
        channel = 'alpha'
        version = $Version
        gitSha = $GitSha
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        signing = [ordered]@{
            required = $SigningRequired
            certificateSubject = if ($Certificate) { [string]$Certificate.Subject } else { $null }
            certificateThumbprint = if ($Certificate) { [string]$Certificate.Thumbprint } else { $null }
            timestampUrl = if ($env:SIGNING_TIMESTAMP_URL) { [string]$env:SIGNING_TIMESTAMP_URL } else { $null }
        }
        artifacts = $manifestArtifacts
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Directory "manifest.json") -Encoding UTF8
}

$repoRoot = Resolve-RepoRoot
$wslPath = Assert-WslRepoPath -Path $WslRepoPath
$outputDir = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $repoRoot "release\windows-alpha" }
$signingRequired = [bool]$RequireSigning -or (ConvertTo-ReleaseBool -Value ([string]$env:SIGNING_REQUIRED))
$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "frontends\electron\package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$gitSha = Invoke-WslCommand -RepoPath $wslPath -Command "git rev-parse --short=12 HEAD" -Capture
if (-not $gitSha) { $gitSha = "unknown" }

Write-Host "NeonCode Windows alpha release"
Write-Host "  Repo root:        $repoRoot"
Write-Host "  WSL repo path:    $wslPath"
Write-Host "  Output directory: $outputDir"
Write-Host "  Version:          $version"
Write-Host "  Git SHA:          $gitSha"
Write-Host "  Signing required: $signingRequired"
Write-Host "  Defender scan:    $(if ($SkipDefender) { 'skipped by request' } else { 'when available' })"

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    Get-ChildItem -LiteralPath $outputDir -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $SkipRustBuild) {
    Invoke-WslCommand -RepoPath $wslPath -Command "cargo build -p neoncode-hub --release"
}
Invoke-WslCommand -RepoPath $wslPath -Command "mkdir -p frontends/electron/resources/hub/linux-x64 && cp target/release/neoncode-hub frontends/electron/resources/hub/linux-x64/neoncode-hub && chmod 700 frontends/electron/resources/hub/linux-x64/neoncode-hub"

if (-not $SkipElectronBuild) {
    Invoke-WslCommand -RepoPath $wslPath -Command "npm --prefix frontends/electron run build"
}
Write-ReleaseInfo -RepoPath $wslPath -Version $version -GitSha $gitSha

if (-not $SkipPackage) {
    Invoke-WslCommand -RepoPath $wslPath -Command "NEONCODE_BUILD_GIT_SHA=$gitSha npm --prefix frontends/electron run package:alpha"
}

if ($DryRun) {
    Write-Host "DRY RUN complete. No artifacts were modified."
    exit 0
}

if (-not (Test-Path -LiteralPath $outputDir -PathType Container)) {
    throw "Release output directory was not created: $outputDir"
}
$certificate = Invoke-AuthenticodeSigning -Directory $outputDir -Required $signingRequired
Write-ReleaseManifestAndHashes -Directory $outputDir -Version $version -GitSha $gitSha -SigningRequired $signingRequired -Certificate $certificate

if (-not $SkipVerify) {
    $verify = Join-Path $PSScriptRoot "verify-release.ps1"
    $verifyArgs = @('-ReleaseDirectory', $outputDir)
    if ($signingRequired) { $verifyArgs += '-RequireSigning' }
    if ($SkipDefender) { $verifyArgs += '-SkipDefender' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verify @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw "Release verification failed with exit code $LASTEXITCODE" }
}

Write-Host "NeonCode alpha release artifacts are ready: $outputDir"
