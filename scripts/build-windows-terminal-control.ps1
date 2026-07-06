param(
    [string]$TerminalRepo = "$env:USERPROFILE\gitrepo\microsoft-terminal",
    [string]$VcpkgRoot = "$env:USERPROFILE\gitrepo\vcpkg",
    [string]$Configuration = "Debug",
    [string]$Platform = "x64"
)

$ErrorActionPreference = "Stop"

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install Visual Studio Build Tools first."
}

$vs = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $vs) {
    throw "No Visual Studio installation with MSBuild was found."
}

$msbuild = Join-Path $vs "MSBuild\Current\Bin\MSBuild.exe"
if (-not (Test-Path $msbuild)) {
    throw "MSBuild.exe not found at $msbuild"
}

$proxyProject = Join-Path $TerminalRepo "src\host\proxy\Host.Proxy.vcxproj"
if (-not (Test-Path $proxyProject)) {
    throw "Host.Proxy.vcxproj not found at $proxyProject"
}

$project = Join-Path $TerminalRepo "src\cascadia\TerminalControl\dll\TerminalControl.vcxproj"
if (-not (Test-Path $project)) {
    throw "TerminalControl.vcxproj not found at $project"
}

$vcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
if (-not (Test-Path $vcpkgExe)) {
    throw "vcpkg.exe not found at $vcpkgExe. Clone microsoft/vcpkg and run bootstrap-vcpkg.bat."
}

# Build from a normal Windows path, not \\wsl.localhost\... UNC paths. Some Windows
# Terminal build scripts and tools do not support UNC path formats.
#
# When building an individual vcxproj instead of the full OpenConsole.sln, MSBuild's
# default SolutionDir points at the project directory. Windows Terminal's props expect
# SolutionDir/OpenConsoleDir to be the repository root.
$solutionDir = $TerminalRepo.TrimEnd('\') + '\'

function Update-RegexIfNeeded {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$AlreadyPatchedPattern,
        [Parameter(Mandatory=$true)][string]$FindPattern,
        [Parameter(Mandatory=$true)][string]$Replacement
    )

    $content = Get-Content $Path -Raw
    if ($content -match $AlreadyPatchedPattern) {
        return
    }

    if (-not ($content -match $FindPattern)) {
        throw "Could not patch $Path; expected source pattern was not found."
    }

    Set-Content -Path $Path -Value ([regex]::Replace($content, $FindPattern, $Replacement, 1)) -NoNewline
    Write-Host "Patched $Path"
}

# v1.22.11141.0 trips newer MSVC warning-as-error checks for two unused parameters.
# Keep these tiny local POC patches reproducible instead of relying on manual edits in
# the external microsoft-terminal checkout.
Update-RegexIfNeeded `
    -Path (Join-Path $TerminalRepo "src\cascadia\TerminalControl\InteractivityAutomationPeer.cpp") `
    -AlreadyPatchedPattern '\(void\)childElement;' `
    -FindPattern '(?s)(RangeFromChild\(XamlAutomation::IRawElementProviderSimple childElement\)\s*\{\s*)(UIA::ITextRangeProvider\* returnVal;)' `
    -Replacement '${1}        (void)childElement;`r`n        ${2}'

Update-RegexIfNeeded `
    -Path (Join-Path $TerminalRepo "src\cascadia\TerminalControl\TermControl.cpp") `
    -AlreadyPatchedPattern '\(void\)args;' `
    -FindPattern '(?s)(_contextMenuHandler\(IInspectable /\*sender\*/,\s*Control::ContextMenuRequestedEventArgs args\)\s*\{\s*)(// Position the menu where the pointer is\.)' `
    -Replacement '${1}        (void)args;`r`n        ${2}'

Write-Host "SolutionDir: $solutionDir"
Write-Host "VcpkgRoot:   $VcpkgRoot"

$commonArgs = @(
    "/m",
    "/restore",
    "/p:Configuration=$Configuration",
    "/p:Platform=$Platform",
    "/p:SolutionDir=$solutionDir",
    "/p:OpenConsoleDir=$solutionDir",
    "/p:VcpkgRoot=$VcpkgRoot",
    "/p:WindowsTargetPlatformVersion=10.0.22621.0",
    "/p:WindowsTargetPlatformMinVersion=10.0.17763.0",
    "/p:TargetPlatformVersion=10.0.22621.0",
    "/p:TargetPlatformMinVersion=10.0.17763.0"
)

# TerminalConnection includes ITerminalHandoff.h from $(IntDir)..\OpenConsoleProxy.
# That header is generated from src\host\proxy\ITerminalHandoff.idl by Host.Proxy.vcxproj.
# Building the individual TerminalControl project does not reliably pull in this dependency,
# so build the proxy project first.
Write-Host "Building generated COM handoff headers via $proxyProject"
& $msbuild $proxyProject @commonArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Building $project"
& $msbuild $project @commonArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$output = Join-Path $TerminalRepo "bin\$Platform\$Configuration\Microsoft.Terminal.Control\Microsoft.Terminal.Control.dll"
Write-Host "Expected output: $output"
