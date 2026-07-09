param(
    [int]$PaneIndex = 1,
    [string]$Command = "echo xtermsmoke",
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NeonCodeXtermSmokeNative {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
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

function Get-XtermElectronLog {
    $path = Join-Path $env:TEMP "NeonCode\electron-xterm-spike-main.log"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Electron xterm log not found: $path. Start './dev app' or './dev electron-xterm' first."
    }
    return $path
}

function Get-XtermWindow {
    $process = Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*NeonCode Electron xterm.js Spike*" } |
        Select-Object -First 1

    if (-not $process) {
        throw "Electron xterm window not found. Start './dev app' or './dev electron-xterm' first."
    }

    return $process
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

if ($PaneIndex -lt 1 -or $PaneIndex -gt 2) {
    throw "PaneIndex is 1-based and must be 1 or 2 for the current xterm spike."
}

$zeroBasedPaneIndex = $PaneIndex - 1
$log = Get-XtermElectronLog
$process = Get-XtermWindow
$hwnd = [IntPtr]$process.MainWindowHandle

Write-Host "Electron PID: $($process.Id)"
Write-Host "Electron HWND: $hwnd"
Write-Host "Electron log: $log"
Write-Host "Pane index:   $PaneIndex"

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_connected for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_connected $zeroBasedPaneIndex")
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_started for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_started $zeroBasedPaneIndex")
}

$before = Read-SharedText -Path $log
$beforeInputCount = ([regex]::Matches($before, [regex]::Escape("terminal_input $zeroBasedPaneIndex "))).Count
$beforeMarkerCount = ([regex]::Matches($before, [regex]::Escape("hub_output_marker $zeroBasedPaneIndex xtermsmoke"))).Count

$rect = New-Object NeonCodeXtermSmokeNative+RECT
[NeonCodeXtermSmokeNative]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
[NeonCodeXtermSmokeNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500

$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$terminalTop = $rect.Top + 120
$terminalY = [Math]::Min($rect.Bottom - 80, $terminalTop)
if ($PaneIndex -eq 1) {
    $terminalX = $rect.Left + [Math]::Max(80, [int]($width * 0.20))
} else {
    $terminalX = $rect.Left + [Math]::Min($width - 80, [int]($width * 0.70))
}

[NeonCodeXtermSmokeNative]::SetCursorPos($terminalX, $terminalY) | Out-Null
[NeonCodeXtermSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) # MOUSEEVENTF_LEFTDOWN
[NeonCodeXtermSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # MOUSEEVENTF_LEFTUP
Start-Sleep -Milliseconds 500

$payload = $Command + "{ENTER}"
[System.Windows.Forms.SendKeys]::SendWait($payload)

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "terminal input for pane $PaneIndex" -Condition {
    $text = Read-SharedText -Path $log
    ([regex]::Matches($text, [regex]::Escape("terminal_input $zeroBasedPaneIndex "))).Count -gt $beforeInputCount
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "xtermsmoke output marker for pane $PaneIndex" -Condition {
    $text = Read-SharedText -Path $log
    ([regex]::Matches($text, [regex]::Escape("hub_output_marker $zeroBasedPaneIndex xtermsmoke"))).Count -gt $beforeMarkerCount
}

$after = Read-SharedText -Path $log
$afterInputCount = ([regex]::Matches($after, [regex]::Escape("terminal_input $zeroBasedPaneIndex "))).Count
$afterMarkerCount = ([regex]::Matches($after, [regex]::Escape("hub_output_marker $zeroBasedPaneIndex xtermsmoke"))).Count

Write-Host "terminal_input: before=$beforeInputCount after=$afterInputCount"
Write-Host "marker_output:  before=$beforeMarkerCount after=$afterMarkerCount"
Write-Host "Electron xterm smoke passed."
