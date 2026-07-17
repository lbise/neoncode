[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [switch]$RequireSigning,
    [switch]$SkipDefender,
    [switch]$ChecklistOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
}

function Resolve-ReleaseDirectory {
    if ($ReleaseDirectory) { return (Resolve-Path -LiteralPath $ReleaseDirectory).ProviderPath }
    return (Resolve-Path -LiteralPath (Join-Path (Resolve-RepoRoot) "release\windows-alpha")).ProviderPath
}

$releaseDir = Resolve-ReleaseDirectory
Write-Host "NeonCode clean-VM alpha release checklist"
Write-Host "  Release directory: $releaseDir"
Write-Host ""
Write-Host "Manual clean-VM requirements:"
Write-Host "  [ ] Fully updated Windows 11/10 VM with Microsoft Defender enabled"
Write-Host "  [ ] Cloud-delivered protection enabled"
Write-Host "  [ ] No Defender exclusions or app-control allow rules for NeonCode"
Write-Host "  [ ] WSL installed with a default Linux distribution"
Write-Host "  [ ] Release copied through normal download/share path used for dogfood"
Write-Host "  [ ] Installer and portable launch behavior recorded, including SmartScreen result"
Write-Host "  [ ] %APPDATA%\\NeonCode config/state and %TEMP%\\NeonCode logs inspected after launch"
Write-Host "  [ ] Hub token absent from process command lines"
Write-Host ""

if (-not $ChecklistOnly) {
    $verifyScript = Join-Path $PSScriptRoot "verify-release.ps1"
    $arguments = @('-ReleaseDirectory', $releaseDir)
    if ($RequireSigning) { $arguments += '-RequireSigning' }
    if ($SkipDefender) { $arguments += '-SkipDefender' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript @arguments
    if ($LASTEXITCODE -ne 0) { throw "Release verification failed with exit code $LASTEXITCODE" }
}

$defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
if ($defenderStatus) {
    Write-Host ""
    Write-Host "Defender status:"
    Write-Host "  AMServiceEnabled:           $($defenderStatus.AMServiceEnabled)"
    Write-Host "  AntivirusEnabled:           $($defenderStatus.AntivirusEnabled)"
    Write-Host "  RealTimeProtectionEnabled:  $($defenderStatus.RealTimeProtectionEnabled)"
    Write-Host "  IsTamperProtected:          $($defenderStatus.IsTamperProtected)"
}

Write-Host ""
Write-Host "Clean-VM checklist prepared. Complete the manual launch/install observations before promoting the alpha."
