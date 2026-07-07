const { app, BrowserWindow, dialog } = require('electron');

// Corporate Windows environments can block Chromium's GPU helper process,
// especially when Electron is launched from a WSL/UNC-backed path. This spike
// does not need GPU acceleration, so disable it before app readiness.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HEADER_HEIGHT = 52;
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:44777/ws';

let mainWindow;
let terminalHostProcess;

function hwndFromNativeWindowHandle(buffer) {
  if (process.platform !== 'win32') {
    throw new Error('This spike only runs on Windows because it embeds a Windows HWND.');
  }

  if (buffer.length >= 8) {
    return buffer.readBigUInt64LE(0).toString();
  }

  return BigInt(buffer.readUInt32LE(0)).toString();
}

function nativeHostExePath() {
  const stagedHost = path.resolve(__dirname, '..', 'native-host', 'NeonCode.ElectronTerminalHost.exe');
  if (fs.existsSync(stagedHost)) {
    return stagedHost;
  }

  return path.resolve(
    __dirname,
    '..',
    'native',
    'NeonCode.ElectronTerminalHost',
    'bin',
    'Debug',
    'net8.0-windows',
    'NeonCode.ElectronTerminalHost.exe',
  );
}

function spawnTerminalHost() {
  const hostExe = process.env.NEONCODE_TERMINAL_HOST_EXE || nativeHostExePath();
  if (!fs.existsSync(hostExe)) {
    dialog.showErrorBox(
      'Native terminal host missing',
      `Native terminal host was not found:\n\n${hostExe}\n\nRun npm run build-native first.`,
    );
    return;
  }

  const hwnd = hwndFromNativeWindowHandle(mainWindow.getNativeWindowHandle());
  const args = [
    `--parent-hwnd=${hwnd}`,
    `--top-offset=${HEADER_HEIGHT}`,
    `--endpoint=${process.env.NEONCODE_HUB_ENDPOINT || DEFAULT_ENDPOINT}`,
    '--command=bash',
  ];

  terminalHostProcess = spawn(hostExe, args, {
    stdio: 'inherit',
    windowsHide: false,
  });

  terminalHostProcess.on('exit', (code, signal) => {
    terminalHostProcess = undefined;
    console.log(`Native terminal host exited: code=${code} signal=${signal}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#111827',
    title: 'NeonCode Electron Native Terminal Spike',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    spawnTerminalHost();
  });

  mainWindow.on('closed', () => {
    if (terminalHostProcess && !terminalHostProcess.killed) {
      terminalHostProcess.kill();
    }
    terminalHostProcess = undefined;
    mainWindow = undefined;
  });
}

app.whenReady().then(() => {
  if (process.platform !== 'win32') {
    dialog.showErrorBox('Unsupported platform', 'This spike must run on Windows.');
    app.quit();
    return;
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (terminalHostProcess && !terminalHostProcess.killed) {
    terminalHostProcess.kill();
  }
  app.quit();
});
