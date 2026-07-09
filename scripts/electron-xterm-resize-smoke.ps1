param(
    [int]$PaneIndex = 1,
    [int]$Width = 1100,
    [int]$Height = 720,
    [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NeonCodeXtermResizeSmokeNative {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

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
    $path = Join-Path $env:TEMP "NeonCode\electron-app-main.log"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Electron app log not found: $path. Start './dev app' or './dev electron' first."
    }
    return $path
}

function Get-XtermWindow {
    $process = Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*NeonCode*" } |
        Select-Object -First 1

    if (-not $process) {
        throw "Electron app window not found. Start './dev app' or './dev electron' first."
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

function Get-LatestResizeEvent {
    param(
        [Parameter(Mandatory=$true)][string]$LogText,
        [Parameter(Mandatory=$true)][int]$ZeroBasedPaneIndex
    )

    $pattern = "terminal_resize $ZeroBasedPaneIndex (\d+) (\d+)"
    $matches = [regex]::Matches($LogText, $pattern)
    if ($matches.Count -eq 0) {
        return $null
    }

    $match = $matches[$matches.Count - 1]
    return [pscustomobject]@{
        Rows = [int]$match.Groups[1].Value
        Cols = [int]$match.Groups[2].Value
        Count = $matches.Count
    }
}

if ($PaneIndex -lt 1 -or $PaneIndex -gt 2) {
    throw "PaneIndex is 1-based and must be 1 or 2 for the current Electron app."
}

$zeroBasedPaneIndex = $PaneIndex - 1
$log = Get-XtermElectronLog
$process = Get-XtermWindow
$hwnd = [IntPtr]$process.MainWindowHandle
$token = "rs" + ([Guid]::NewGuid().ToString("N").Substring(0, 8))

Write-Host "Electron PID: $($process.Id)"
Write-Host "Electron HWND: $hwnd"
Write-Host "Electron log: $log"
Write-Host "Pane index:   $PaneIndex"
Write-Host "Resize token: $token"

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_connected for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_connected $zeroBasedPaneIndex")
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_started for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_started $zeroBasedPaneIndex")
}

$rect = New-Object NeonCodeXtermResizeSmokeNative+RECT
[NeonCodeXtermResizeSmokeNative]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$currentWidth = [Math]::Max(1, $rect.Right - $rect.Left)
$currentHeight = [Math]::Max(1, $rect.Bottom - $rect.Top)
if ([Math]::Abs($currentWidth - $Width) -lt 20 -and [Math]::Abs($currentHeight - $Height) -lt 20) {
    $Width += 160
    $Height += 120
}

$before = Read-SharedText -Path $log
$beforeResize = Get-LatestResizeEvent -LogText $before -ZeroBasedPaneIndex $zeroBasedPaneIndex
$beforeResizeCount = if ($beforeResize) { $beforeResize.Count } else { 0 }

[NeonCodeXtermResizeSmokeNative]::SetForegroundWindow($hwnd) | Out-Null
[NeonCodeXtermResizeSmokeNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $rect.Left, $rect.Top, $Width, $Height, 0x0044) | Out-Null # SWP_NOZORDER | SWP_SHOWWINDOW
Start-Sleep -Milliseconds 750

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "terminal_resize for pane $PaneIndex" -Condition {
    $text = Read-SharedText -Path $log
    $resize = Get-LatestResizeEvent -LogText $text -ZeroBasedPaneIndex $zeroBasedPaneIndex
    $resize -and $resize.Count -gt $beforeResizeCount
}

$afterResizeText = Read-SharedText -Path $log
$resizeEvent = Get-LatestResizeEvent -LogText $afterResizeText -ZeroBasedPaneIndex $zeroBasedPaneIndex
if (-not $resizeEvent) {
    throw "No terminal_resize event found for pane $PaneIndex"
}

[NeonCodeXtermResizeSmokeNative]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$windowWidth = [Math]::Max(1, $rect.Right - $rect.Left)
$terminalTop = $rect.Top + 120
$terminalY = [Math]::Min($rect.Bottom - 80, $terminalTop)
if ($PaneIndex -eq 1) {
    $terminalX = $rect.Left + [Math]::Max(80, [int]($windowWidth * 0.20))
} else {
    $terminalX = $rect.Left + [Math]::Min($windowWidth - 80, [int]($windowWidth * 0.70))
}

[NeonCodeXtermResizeSmokeNative]::SetCursorPos($terminalX, $terminalY) | Out-Null
[NeonCodeXtermResizeSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[NeonCodeXtermResizeSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500

$command = "printf 'xtermresize:${token}:%s\n' `"`$(stty size)`""
Set-Clipboard -Value $command
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^+v{ENTER}")

$expected = "hub_output_resize $zeroBasedPaneIndex $token $($resizeEvent.Rows) $($resizeEvent.Cols)"
Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "PTY stty size matching latest xterm resize ($expected)" -Condition {
    (Read-SharedText -Path $log).Contains($expected)
}

Write-Host "Window size:     ${Width}x${Height}"
Write-Host "xterm size:      rows=$($resizeEvent.Rows) cols=$($resizeEvent.Cols)"
Write-Host "Matched marker:  $expected"
Write-Host "Electron xterm resize smoke passed."
