param(
    [string]$DependencyConfig = "$(Split-Path -Parent $PSScriptRoot)\deps\windows-terminal.json",
    [string]$TerminalRepo = "$env:USERPROFILE\gitrepo\microsoft-terminal",
    [string]$VcpkgRoot = "$env:USERPROFILE\gitrepo\vcpkg",
    [string]$Repository,
    [string]$Tag,
    [string]$Commit,
    [string]$PatchDirectory,
    [switch]$SkipVcpkgBootstrap
)

$ErrorActionPreference = "Stop"

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
$script:GitExe = $null
if ($gitCommand) {
    $script:GitExe = $gitCommand.Source
} else {
    $commonGitPaths = @(
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
    )

    foreach ($candidate in $commonGitPaths) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $script:GitExe = $candidate
            break
        }
    }
}

if (-not $script:GitExe) {
    throw @"
Git for Windows was not found.

This dependency bootstrap intentionally requires Windows-native git because the
Windows Terminal checkout lives on the Windows filesystem and WSL git over /mnt/c
is slow and can trigger Windows Defender scanning/locking problems.

Install Git for Windows, then rerun this script:
  https://git-scm.com/download/win
"@
}

function Invoke-GitRaw {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)

    & $script:GitExe @Arguments
}

function Invoke-GitChecked {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)

    Invoke-GitRaw -Arguments $Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git command failed: git $($Arguments -join ' ')"
    }
}

function Invoke-GitExitCode {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $script:GitExe @Arguments *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Normalize-GitPath {
    param([Parameter(Mandatory=$true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-VisualStudioRequirement {
    param(
        [Parameter(Mandatory=$true)][string]$Component,
        [Parameter(Mandatory=$true)][string]$Description
    )

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found. Install Visual Studio 2022 Build Tools first."
    }

    $installPath = & $vswhere -latest -products * -requires $Component -property installationPath
    if (-not $installPath) {
        throw "Missing Visual Studio component: $Component ($Description). See docs/windows-terminal-embedding.md for the install command."
    }

    return $installPath
}

if (Test-Path -LiteralPath $DependencyConfig) {
    $dependency = Get-Content -LiteralPath $DependencyConfig -Raw | ConvertFrom-Json
    $Repository = if ($Repository) { $Repository } else { $dependency.repository }
    $Tag = if ($Tag) { $Tag } else { $dependency.tag }
    $Commit = if ($Commit) { $Commit } else { $dependency.commit }
    $PatchDirectory = if ($PatchDirectory) { $PatchDirectory } else { Join-Path (Split-Path -Parent $PSScriptRoot) $dependency.patchDirectory }
}

if (-not $Repository) { $Repository = "https://github.com/microsoft/terminal.git" }
if (-not $Tag) { throw "Windows Terminal tag was not provided and could not be read from $DependencyConfig" }

Write-Host "Bootstrapping Windows Terminal dependency"
Write-Host "Repository:   $Repository"
Write-Host "Tag:          $Tag"
if ($Commit) { Write-Host "Commit:       $Commit" }
Write-Host "TerminalRepo: $TerminalRepo"
Write-Host "VcpkgRoot:    $VcpkgRoot"
Write-Host "Git:          $script:GitExe"

Write-Host "Checking Visual Studio/MSBuild requirements..."
$null = Assert-VisualStudioRequirement -Component "Microsoft.Component.MSBuild" -Description "MSBuild"
$null = Assert-VisualStudioRequirement -Component "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" -Description "MSVC x64/x86 tools"
$null = Assert-VisualStudioRequirement -Component "Microsoft.VisualStudio.Component.Windows11SDK.22621" -Description "Windows 11 SDK 10.0.22621"
$vsPath = Assert-VisualStudioRequirement -Component "Microsoft.VisualStudio.ComponentGroup.UWP.VC.BuildTools" -Description "UWP/Windows Store C++ build tools"
Write-Host "Visual Studio requirements found."

$storeToolset = Join-Path $vsPath "MSBuild\Microsoft\VC\v170\Application Type\Windows Store\10.0\Platforms\x64\PlatformToolsets\v143"
if (-not (Test-Path -LiteralPath $storeToolset)) {
    throw "Windows Store v143 x64 toolset folder not found at $storeToolset. Re-run the Visual Studio Build Tools install command from docs/windows-terminal-embedding.md."
}
Write-Host "Windows Store v143 toolset found."

$terminalParent = Split-Path -Parent $TerminalRepo
Write-Host "Ensuring dependency parent exists: $terminalParent"
if (-not [System.IO.Directory]::Exists($terminalParent)) {
    [System.IO.Directory]::CreateDirectory($terminalParent) | Out-Null
}

$terminalGitDir = Join-Path $TerminalRepo ".git"
Write-Host "Checking Windows Terminal checkout..."
if (-not [System.IO.Directory]::Exists($terminalGitDir)) {
    Write-Host "Cloning Windows Terminal source..."
    $cloneDestination = Normalize-GitPath $TerminalRepo
    Invoke-GitChecked -Arguments @("clone", "--filter=blob:none", $Repository, $cloneDestination)
}

$terminalRepoForGit = Normalize-GitPath $TerminalRepo
Write-Host "Git repo path: $terminalRepoForGit"
Write-Host "Setting origin remote..."
Invoke-GitChecked -Arguments @("-C", $terminalRepoForGit, "remote", "set-url", "origin", $Repository)

$tagRef = "$Tag^{commit}"
$tagExists = Invoke-GitExitCode -Arguments @("-C", $terminalRepoForGit, "rev-parse", "--verify", $tagRef)
if ($tagExists -eq 0) {
    Write-Host "Pinned tag already present locally: $Tag"
} else {
    Write-Host "Fetching pinned tag: $Tag"
    Invoke-GitChecked -Arguments @("-C", $terminalRepoForGit, "fetch", "--depth", "1", "origin", "refs/tags/$Tag:refs/tags/$Tag")
}

Write-Host "Checking out pinned tag..."
Invoke-GitChecked -Arguments @("-C", $terminalRepoForGit, "checkout", "--force", $Tag)

if ($Commit) {
    Write-Host "Resetting to pinned commit..."
    Invoke-GitChecked -Arguments @("-C", $terminalRepoForGit, "reset", "--hard", $Commit)
}

if ($PatchDirectory) {
    if (-not (Test-Path -LiteralPath $PatchDirectory -PathType Container)) {
        throw "Patch directory not found: $PatchDirectory"
    }

    $patches = Get-ChildItem -LiteralPath $PatchDirectory -Filter "*.patch" | Sort-Object Name
    foreach ($patch in $patches) {
        $patchPathForGit = Normalize-GitPath $patch.FullName
        Write-Host "Applying patch: $($patch.Name)"

        $applyOptions = @("--ignore-space-change", "--whitespace=nowarn")
        $reverseCheck = Invoke-GitExitCode -Arguments (@("-C", $terminalRepoForGit, "apply") + $applyOptions + @("--reverse", "--check", $patchPathForGit))
        if ($reverseCheck -eq 0) {
            Write-Host "  already applied"
            continue
        }

        Invoke-GitChecked -Arguments (@("-C", $terminalRepoForGit, "apply") + $applyOptions + @("--check", $patchPathForGit))
        Invoke-GitChecked -Arguments (@("-C", $terminalRepoForGit, "apply") + $applyOptions + @($patchPathForGit))
    }
}

$vcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
if (-not (Test-Path -LiteralPath $vcpkgExe)) {
    if ($SkipVcpkgBootstrap) {
        throw "vcpkg.exe not found at $vcpkgExe and -SkipVcpkgBootstrap was specified."
    }

    $vcpkgParent = Split-Path -Parent $VcpkgRoot
    New-Item -ItemType Directory -Force -Path $vcpkgParent | Out-Null

    if (-not (Test-Path -LiteralPath (Join-Path $VcpkgRoot ".git"))) {
        Write-Host "Cloning vcpkg..."
        Invoke-GitChecked -Arguments @("clone", "https://github.com/microsoft/vcpkg.git", (Normalize-GitPath $VcpkgRoot))
    }

    $bootstrap = Join-Path $VcpkgRoot "bootstrap-vcpkg.bat"
    if (-not (Test-Path -LiteralPath $bootstrap)) {
        throw "bootstrap-vcpkg.bat not found at $bootstrap"
    }

    Write-Host "Bootstrapping vcpkg..."
    & cmd.exe /c "`"$bootstrap`""
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path -LiteralPath $vcpkgExe)) {
    throw "vcpkg.exe was not created at $vcpkgExe"
}

Write-Host ""
Write-Host "Windows Terminal dependency is ready."
Write-Host "Next build command:"
Write-Host "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1"
