param(
    [int]$PaneIndex = 1,
    [string]$Command = "echo direct-hub-smoke",
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NeonCodeDirectHubSmoke {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

function Read-SharedText {
    param([Parameter(Mandatory=$true)][string]$Path)

    $stream = [System.IO.FileStream]::new(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
        try {
            return $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-DirectCoordinatorLog {
    param([Parameter(Mandatory=$true)][int]$PaneIndex)

    $logDir = Join-Path $env:TEMP "NeonCode"
    $log = Get-ChildItem -LiteralPath $logDir -Filter "direct-coordinator-*-pane-$PaneIndex.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $log) {
        throw "No direct coordinator log found for pane $PaneIndex in $logDir. Start './dev app' first."
    }

    return $log.FullName
}

function Get-ElectronLog {
    $path = Join-Path $env:TEMP "NeonCode\electron-native-spike-main.log"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Electron log not found: $path. Start './dev app' first."
    }
    return $path
}

function Count-HubOutputEvents {
    param(
        [Parameter(Mandatory=$true)][string]$ElectronLogText,
        [Parameter(Mandatory=$true)][int]$ZeroBasedPaneIndex
    )

    $pattern = 'hub_output ' + $ZeroBasedPaneIndex + ' '
    return ([regex]::Matches($ElectronLogText, [regex]::Escape($pattern))).Count
}

function Wait-ForCondition {
    param(
        [Parameter(Mandatory=$true)][scriptblock]$Condition,
        [Parameter(Mandatory=$true)][string]$Description,
        [Parameter(Mandatory=$true)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for: $Description"
}

if ($PaneIndex -lt 1) {
    throw "PaneIndex is 1-based and must be >= 1."
}

$zeroBasedPaneIndex = $PaneIndex - 1
$electronLog = Get-ElectronLog
$coordinatorLog = Get-DirectCoordinatorLog -PaneIndex $PaneIndex

Write-Host "Electron log:    $electronLog"
Write-Host "Coordinator log: $coordinatorLog"
Write-Host "Pane index:      $PaneIndex"

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_connected for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $electronLog).Contains("hub_connected $zeroBasedPaneIndex")
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_started for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $electronLog).Contains("hub_started $zeroBasedPaneIndex")
}

$beforeElectron = Read-SharedText -Path $electronLog
$beforeOutputCount = Count-HubOutputEvents -ElectronLogText $beforeElectron -ZeroBasedPaneIndex $zeroBasedPaneIndex

$coordinatorText = Read-SharedText -Path $coordinatorLog
if ($coordinatorText -notmatch "terminalHwnd=(0x[0-9A-Fa-f]+)") {
    throw "Could not find terminalHwnd in coordinator log: $coordinatorLog"
}

$terminalHwnd = [IntPtr]([Convert]::ToInt64($Matches[1].Substring(2), 16))
Write-Host "Terminal HWND:   $terminalHwnd"

$payload = $Command + "`r"
foreach ($ch in $payload.ToCharArray()) {
    [NeonCodeDirectHubSmoke]::PostMessage($terminalHwnd, 0x0102, [IntPtr][int][char]$ch, [IntPtr]0) | Out-Null # WM_CHAR
    Start-Sleep -Milliseconds 20
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "new hub_output after posted input" -Condition {
    $text = Read-SharedText -Path $electronLog
    (Count-HubOutputEvents -ElectronLogText $text -ZeroBasedPaneIndex $zeroBasedPaneIndex) -gt $beforeOutputCount
}

$afterCoordinator = Read-SharedText -Path $coordinatorLog
$wmCharCount = ([regex]::Matches($afterCoordinator, "WM_CHAR")).Count
$afterElectron = Read-SharedText -Path $electronLog
$afterOutputCount = Count-HubOutputEvents -ElectronLogText $afterElectron -ZeroBasedPaneIndex $zeroBasedPaneIndex

Write-Host "WM_CHAR count:   $wmCharCount"
Write-Host "hub_output:      before=$beforeOutputCount after=$afterOutputCount"
Write-Host "Direct coordinator hub smoke passed."
