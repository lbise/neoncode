param(
    [int]$Cycles = 6,
    [int]$DelayMilliseconds = 500,
    [string]$TextPrefix = "nc"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeFocusTest {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

function Get-ElectronSpikeWindow {
    $process = Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*NeonCode Electron Native Terminal Spike*" } |
        Select-Object -First 1

    if (-not $process) {
        throw "Electron spike window not found. Start './dev electron-spike-direct' or './dev electron-spike' first."
    }

    return $process
}

function Send-TestText {
    param([string]$Text)
    [System.Windows.Forms.SendKeys]::SendWait($Text)
}

$process = Get-ElectronSpikeWindow
$hwnd = [IntPtr]$process.MainWindowHandle
Write-Host "Electron PID: $($process.Id)"
Write-Host "Electron HWND: $hwnd"
Write-Host "Cycles: $Cycles"
Write-Host "Logs: $env:TEMP\NeonCode"

[NativeFocusTest]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds $DelayMilliseconds

for ($i = 1; $i -le $Cycles; $i++) {
    Write-Host "Cycle $i: type before minimize"
    [NativeFocusTest]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds $DelayMilliseconds
    Send-TestText "$TextPrefix$i"
    Start-Sleep -Milliseconds $DelayMilliseconds

    Write-Host "Cycle $i: minimize"
    [NativeFocusTest]::ShowWindowAsync($hwnd, 6) | Out-Null # SW_MINIMIZE
    Start-Sleep -Milliseconds $DelayMilliseconds

    Write-Host "Cycle $i: restore"
    [NativeFocusTest]::ShowWindowAsync($hwnd, 9) | Out-Null # SW_RESTORE
    Start-Sleep -Milliseconds $DelayMilliseconds
    [NativeFocusTest]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds $DelayMilliseconds

    $foreground = [NativeFocusTest]::GetForegroundWindow()
    $isMinimized = [NativeFocusTest]::IsIconic($hwnd)
    Write-Host "Cycle $i: foreground=$foreground minimized=$isMinimized type after restore"
    Send-TestText "R$i"
    Start-Sleep -Milliseconds $DelayMilliseconds
}

Write-Host "Done. Inspect recent logs with:"
Write-Host "  Get-ChildItem `$env:TEMP\NeonCode\*.log | Sort-Object LastWriteTime"
Write-Host "  Get-Content `$env:TEMP\NeonCode\electron-native-spike-main.log -Tail 200"
Write-Host "  Get-Content `$env:TEMP\NeonCode\direct-coordinator-*.log -Tail 200"
