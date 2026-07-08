const { app, BrowserWindow, Menu, dialog } = require('electron');

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
const DEFAULT_TERMINAL_COUNT = 2;
const TERMINAL_GAP = 8;

let mainWindow;
let terminalHostProcesses = [];
let pendingFocusTimers = [];

function hwndFromNativeWindowHandle(buffer) {
  if (process.platform !== 'win32') {
    throw new Error('This spike only runs on Windows because it embeds a Windows HWND.');
  }

  if (buffer.length >= 8) {
    return buffer.readBigUInt64LE(0).toString();
  }

  return BigInt(buffer.readUInt32LE(0)).toString();
}

function terminalHostKind() {
  return (process.env.NEONCODE_TERMINAL_HOST_KIND || 'wpf').toLowerCase();
}

function nativeHostExePath() {
  const kind = terminalHostKind();
  const executableName = kind === 'coordinator'
    ? 'NeonCode.NativeTerminalCoordinator.exe'
    : 'NeonCode.ElectronTerminalHost.exe';
  const stagedHost = path.resolve(__dirname, '..', 'native-host', executableName);
  if (fs.existsSync(stagedHost)) {
    return stagedHost;
  }

  if (kind === 'coordinator') {
    return path.resolve(
      __dirname,
      '..',
      'native',
      'NeonCode.NativeTerminalCoordinator',
      'bin',
      'x64',
      'Debug',
      'NeonCode.NativeTerminalCoordinator.exe',
    );
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

function terminalCount() {
  const parsed = Number.parseInt(process.env.NEONCODE_TERMINAL_COUNT || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TERMINAL_COUNT;
}

function liveTerminalHosts() {
  return terminalHostProcesses.filter((process) => process && !process.killed);
}

function killTerminalHosts() {
  for (const process of liveTerminalHosts()) {
    process.kill();
  }
  terminalHostProcesses = [];
}

function spawnTerminalHosts() {
  const hostExe = process.env.NEONCODE_TERMINAL_HOST_EXE || nativeHostExePath();
  if (!fs.existsSync(hostExe)) {
    dialog.showErrorBox(
      'Native terminal host missing',
      `Native terminal host was not found:\n\n${hostExe}\n\nRun npm run build-native first.`,
    );
    return;
  }

  const count = terminalCount();
  const hwnd = hwndFromNativeWindowHandle(mainWindow.getNativeWindowHandle());
  terminalHostProcesses = [];

  for (let index = 0; index < count; index += 1) {
    const args = [
      `--parent-hwnd=${hwnd}`,
      `--top-offset=${HEADER_HEIGHT}`,
      `--column-index=${index}`,
      `--column-count=${count}`,
      `--column-gap=${TERMINAL_GAP}`,
      `--session-id=electron-spike-shell-${index + 1}`,
      `--endpoint=${process.env.NEONCODE_HUB_ENDPOINT || DEFAULT_ENDPOINT}`,
      '--command=bash',
    ];

    const hostProcess = spawn(hostExe, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: false,
    });

    hostProcess.stdin.setDefaultEncoding('utf8');
    hostProcess.on('exit', (code, signal) => {
      terminalHostProcesses = terminalHostProcesses.filter((process) => process !== hostProcess);
      console.log(`Native terminal host ${index + 1} exited: code=${code} signal=${signal}`);
    });

    terminalHostProcesses.push(hostProcess);
  }

  setTimeout(() => focusTerminalHost('spawn'), 250);
}

function sendTerminalFocusCommand(reason) {
  for (const process of liveTerminalHosts()) {
    if (process.stdin?.writable) {
      process.stdin.write(`focus ${reason}\n`);
    }
  }
}

function clearPendingFocusTimers() {
  for (const timer of pendingFocusTimers) {
    clearTimeout(timer);
  }
  pendingFocusTimers = [];
}

function focusTerminalHost(reason, options = {}) {
  clearPendingFocusTimers();

  const delays = options.delays || [0, 50, 150, 300];
  const requireFocusedWindow = options.requireFocusedWindow ?? true;

  for (const delay of delays) {
    const timer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
        return;
      }

      if (requireFocusedWindow && !mainWindow.isFocused()) {
        return;
      }

      sendTerminalFocusCommand(`${reason}+${delay}`);
    }, delay);
    pendingFocusTimers.push(timer);
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

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
    spawnTerminalHosts();
  });

  mainWindow.on('focus', () => focusTerminalHost('electron-focus'));
  mainWindow.on('show', () => focusTerminalHost('electron-show'));
  mainWindow.on('blur', clearPendingFocusTimers);
  mainWindow.on('minimize', clearPendingFocusTimers);

  mainWindow.on('restore', () => {
    // The native child HWND can need a nudge after parent minimize/restore.
    // The native host also polls the parent bounds, but this gives Windows a
    // fresh child-window layout event from the Electron side.
    if (liveTerminalHosts().length > 0) {
      mainWindow.setSize(...mainWindow.getSize());
      focusTerminalHost('electron-restore', {
        delays: [50, 150, 300, 600],
        requireFocusedWindow: false,
      });
    }
  });

  mainWindow.on('closed', () => {
    clearPendingFocusTimers();
    killTerminalHosts();
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
  killTerminalHosts();
  app.quit();
});
