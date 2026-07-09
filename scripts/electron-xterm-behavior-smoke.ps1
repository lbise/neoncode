param(
    [int]$PaneIndex = 1,
    [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NeonCodeXtermBehaviorSmokeNative {
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

function Focus-XtermPane {
    param(
        [Parameter(Mandatory=$true)][IntPtr]$Hwnd,
        [Parameter(Mandatory=$true)][int]$PaneIndex
    )

    $rect = New-Object NeonCodeXtermBehaviorSmokeNative+RECT
    [NeonCodeXtermBehaviorSmokeNative]::GetWindowRect($Hwnd, [ref]$rect) | Out-Null
    [NeonCodeXtermBehaviorSmokeNative]::SetForegroundWindow($Hwnd) | Out-Null
    Start-Sleep -Milliseconds 400

    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $terminalY = [Math]::Min($rect.Bottom - 80, $rect.Top + 120)
    if ($PaneIndex -eq 1) {
        $terminalX = $rect.Left + [Math]::Max(80, [int]($width * 0.20))
    } else {
        $terminalX = $rect.Left + [Math]::Min($width - 80, [int]($width * 0.70))
    }

    [NeonCodeXtermBehaviorSmokeNative]::SetCursorPos($terminalX, $terminalY) | Out-Null
    [NeonCodeXtermBehaviorSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [NeonCodeXtermBehaviorSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
}

function Send-XtermCommand {
    param(
        [Parameter(Mandatory=$true)][string]$Command
    )

    Set-Clipboard -Value $Command
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^+v{ENTER}")
}

function Wait-XtermCheck {
    param(
        [Parameter(Mandatory=$true)][string]$Log,
        [Parameter(Mandatory=$true)][int]$ZeroBasedPaneIndex,
        [Parameter(Mandatory=$true)][string]$Token,
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][int]$TimeoutSeconds
    )

    $pattern = "hub_output_check $ZeroBasedPaneIndex $Token $Name "
    Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "$Name marker for pane $($ZeroBasedPaneIndex + 1)" -Condition {
        (Read-SharedText -Path $Log).Contains($pattern)
    }

    $text = Read-SharedText -Path $Log
    $regex = [regex]::Escape("hub_output_check $ZeroBasedPaneIndex $Token $Name ") + "([A-Za-z0-9_.-]+)"
    $matches = [regex]::Matches($text, $regex)
    if ($matches.Count -eq 0) {
        throw "Marker disappeared unexpectedly: $pattern"
    }

    return $matches[$matches.Count - 1].Groups[1].Value
}

if ($PaneIndex -lt 1 -or $PaneIndex -gt 2) {
    throw "PaneIndex is 1-based and must be 1 or 2 for the current xterm spike."
}

$zeroBasedPaneIndex = $PaneIndex - 1
$log = Get-XtermElectronLog
$process = Get-XtermWindow
$hwnd = [IntPtr]$process.MainWindowHandle
$token = "bh" + ([Guid]::NewGuid().ToString("N").Substring(0, 8))

Write-Host "Electron PID: $($process.Id)"
Write-Host "Electron HWND: $hwnd"
Write-Host "Electron log: $log"
Write-Host "Pane index:   $PaneIndex"
Write-Host "Token:        $token"

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_connected for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_connected $zeroBasedPaneIndex")
}

Wait-ForCondition -TimeoutSeconds $TimeoutSeconds -Description "hub_started for pane $PaneIndex" -Condition {
    (Read-SharedText -Path $log).Contains("hub_started $zeroBasedPaneIndex")
}

Focus-XtermPane -Hwnd $hwnd -PaneIndex $PaneIndex

Send-XtermCommand -Command "printf 'xtermcheck:${token}:basic:ok\n'"
$basic = Wait-XtermCheck -Log $log -ZeroBasedPaneIndex $zeroBasedPaneIndex -Token $token -Name "basic" -TimeoutSeconds $TimeoutSeconds
if ($basic -ne "ok") {
    throw "Basic command marker failed: $basic"
}

Send-XtermCommand -Command "if command -v tmux >/dev/null 2>&1; then printf 'xtermcheck:${token}:tmux:present\n'; else printf 'xtermcheck:${token}:tmux:missing\n'; fi"
$tmux = Wait-XtermCheck -Log $log -ZeroBasedPaneIndex $zeroBasedPaneIndex -Token $token -Name "tmux" -TimeoutSeconds $TimeoutSeconds

Send-XtermCommand -Command "if command -v nvim >/dev/null 2>&1; then printf 'xtermcheck:${token}:nvim:present\n'; else printf 'xtermcheck:${token}:nvim:missing\n'; fi"
$nvim = Wait-XtermCheck -Log $log -ZeroBasedPaneIndex $zeroBasedPaneIndex -Token $token -Name "nvim" -TimeoutSeconds $TimeoutSeconds

$ctrlcCommand = 'trap ''printf "xtermcheck:' + $token + ':ctrlc:ok\n"'' INT; sleep 30'
Send-XtermCommand -Command $ctrlcCommand
Start-Sleep -Milliseconds 750
[System.Windows.Forms.SendKeys]::SendWait("^c")
$ctrlc = Wait-XtermCheck -Log $log -ZeroBasedPaneIndex $zeroBasedPaneIndex -Token $token -Name "ctrlc" -TimeoutSeconds $TimeoutSeconds
if ($ctrlc -ne "ok") {
    throw "Ctrl+C marker failed: $ctrlc"
}

Write-Host "basic: $basic"
Write-Host "tmux:  $tmux"
Write-Host "nvim:  $nvim"
Write-Host "ctrlc: $ctrlc"
Write-Host "Electron xterm behavior smoke passed."
