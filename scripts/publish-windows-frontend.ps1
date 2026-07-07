param(
    [string]$Configuration = "Debug",
    [string]$ProjectPath,
    [string]$OutputPath = "$env:USERPROFILE\neoncode-publish",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Description
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        throw "$Description not found at: $Path"
    }

    return $resolved.ProviderPath
}

function Assert-FileExists {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found at: $Path"
    }
}

function Assert-DirectoryExists {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description was not found at: $Path"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ProjectPath) {
    $ProjectPath = Join-Path $repoRoot "frontends\windows\NeonCode.Windows\NeonCode.Windows.csproj"
}

$project = Resolve-RequiredPath -Path $ProjectPath -Description "Windows frontend project"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet was not found on PATH. Install the .NET 8 SDK."
}

if ($Clean -and (Test-Path -LiteralPath $OutputPath)) {
    Write-Host "Cleaning publish output: $OutputPath"
    Remove-Item -LiteralPath $OutputPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null

Write-Host "Publishing NeonCode Windows frontend"
Write-Host "Project:       $project"
Write-Host "Configuration: $Configuration"
Write-Host "Output:        $OutputPath"

$publishArgs = @(
    "publish",
    $project,
    "-c", $Configuration,
    "-o", $OutputPath,
    "-v:minimal"
)

& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$appExe = Join-Path $OutputPath "NeonCode.Windows.exe"
$terminalDll = Join-Path $OutputPath "Microsoft.Terminal.Control.dll"
$terminalPri = Join-Path $OutputPath "Microsoft.Terminal.Control.pri"
$terminalResources = Join-Path $OutputPath "Microsoft.Terminal.Control"

Assert-FileExists -Path $appExe -Description "Published app executable"
Assert-FileExists -Path $terminalDll -Description "Windows Terminal native DLL"
Assert-FileExists -Path $terminalPri -Description "Windows Terminal PRI resource file"
Assert-DirectoryExists -Path $terminalResources -Description "Windows Terminal resource directory"

Write-Host ""
Write-Host "Publish succeeded."
Write-Host "Verified:"
Write-Host "  $appExe"
Write-Host "  $terminalDll"
Write-Host "  $terminalPri"
Write-Host "  $terminalResources"
Write-Host ""
Write-Host "Run:"
Write-Host "  & '$appExe'"
