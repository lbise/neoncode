const { app, BrowserWindow, Menu, dialog, screen } = require('electron');

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
let activeTerminalIndex = 0;
let logFilePath;
let pendingBoundsTimer;

function ensureLogFile() {
  if (logFilePath) {
    return logFilePath;
  }

  const logDir = path.join(app.getPath('temp'), 'NeonCode');
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'electron-native-spike-main.log');
  fs.appendFileSync(logFilePath, `\n=== Electron spike start ${new Date().toISOString()} pid=${process.pid} ===\n`);
  return logFilePath;
}

function log(message, details) {
  try {
    const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    fs.appendFileSync(ensureLogFile(), `${new Date().toISOString()} ${message}${payload}\n`);
  } catch {
    // Logging must never break the spike.
  }
}

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

function isCoordinatorMode() {
  return terminalHostKind() === 'coordinator';
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
  log('spawnTerminalHosts.begin', { hostExe, kind: terminalHostKind(), count: terminalCount() });
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

    log('host.spawn', { index, args });
    const coordinatorMode = isCoordinatorMode();
    const hostProcess = spawn(hostExe, args, {
      stdio: coordinatorMode ? ['pipe', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'],
      windowsHide: false,
    });

    hostProcess.neoncodeIndex = index;
    hostProcess.neoncodeCount = count;
    hostProcess.neoncodeStdoutBuffer = '';
    hostProcess.stdin.setDefaultEncoding('utf8');
    if (coordinatorMode && hostProcess.stdout) {
      hostProcess.stdout.setEncoding('utf8');
      hostProcess.stdout.on('data', (chunk) => handleCoordinatorOutput(hostProcess, chunk));
    }
    hostProcess.on('exit', (code, signal) => {
      terminalHostProcesses = terminalHostProcesses.filter((process) => process !== hostProcess);
      log('host.exit', { index, code, signal });
      console.log(`Native terminal host ${index + 1} exited: code=${code} signal=${signal}`);
    });

    terminalHostProcesses.push(hostProcess);
  }

  setTimeout(() => {
    sendTerminalBoundsCommand();
    focusTerminalHost('spawn');
  }, 250);
}

function currentDpi() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return 96;
  }

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  return Math.max(1, Math.round((display.scaleFactor || 1) * 96));
}

function terminalBounds(index, count) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return undefined;
  }

  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  if (contentWidth < 100 || contentHeight < HEADER_HEIGHT + 100) {
    log('bounds.skip.invalidContentSize', { contentWidth, contentHeight, minimized: mainWindow.isMinimized() });
    return undefined;
  }

  const top = Math.max(0, Math.min(HEADER_HEIGHT, contentHeight - 1));
  const height = Math.max(1, contentHeight - top);
  const gapTotal = TERMINAL_GAP * Math.max(0, count - 1);
  const availableWidth = Math.max(1, contentWidth - gapTotal);
  const baseWidth = Math.max(1, Math.floor(availableWidth / count));
  const left = index * (baseWidth + TERMINAL_GAP);
  const width = index === count - 1 ? Math.max(1, contentWidth - left) : baseWidth;

  return { x: left, y: top, width, height, dpi: currentDpi() };
}

function sendTerminalBoundsCommand() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    log('bounds.skip.windowUnavailableOrMinimized');
    return;
  }

  for (const process of liveTerminalHosts()) {
    if (!process.stdin?.writable) {
      continue;
    }

    const count = process.neoncodeCount || terminalHostProcesses.length || 1;
    const index = process.neoncodeIndex || 0;
    const bounds = terminalBounds(index, count);
    if (!bounds) {
      continue;
    }

    const command = `bounds ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height} ${bounds.dpi}`;
    log('host.command.bounds', { index, command });
    process.stdin.write(`${command}\n`);
  }
}

function scheduleTerminalBoundsCommand(reason) {
  if (pendingBoundsTimer) {
    clearTimeout(pendingBoundsTimer);
  }

  pendingBoundsTimer = setTimeout(() => {
    pendingBoundsTimer = undefined;
    log('bounds.scheduled.fire', { reason });
    sendTerminalBoundsCommand();
  }, 50);
}

function sendTerminalBlurCommand(reason) {
  clearPendingFocusTimers();
  for (const process of liveTerminalHosts()) {
    if (process.stdin?.writable) {
      log('host.command.blur', { index: process.neoncodeIndex || 0, reason });
      process.stdin.write(`blur ${reason}\n`);
    }
  }
}

function handleCoordinatorOutput(hostProcess, chunk) {
  hostProcess.neoncodeStdoutBuffer += chunk;

  for (;;) {
    const newline = hostProcess.neoncodeStdoutBuffer.indexOf('\n');
    if (newline < 0) {
      break;
    }

    const line = hostProcess.neoncodeStdoutBuffer.slice(0, newline).trim();
    hostProcess.neoncodeStdoutBuffer = hostProcess.neoncodeStdoutBuffer.slice(newline + 1);
    if (!line) {
      continue;
    }

    log('coordinator.event', { index: hostProcess.neoncodeIndex || 0, line });
    const match = /^focus_changed\s+(\d+)$/.exec(line);
    if (match) {
      activeTerminalIndex = Number.parseInt(match[1], 10);
      log('activeTerminalIndex.changed', { activeTerminalIndex });
    }
  }
}

function sendTerminalFocusCommand(reason) {
  for (const process of liveTerminalHosts()) {
    const index = process.neoncodeIndex || 0;
    if (isCoordinatorMode() && index !== activeTerminalIndex) {
      continue;
    }

    if (process.stdin?.writable) {
      log('host.command.focus', { index, reason, activeTerminalIndex });
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

  const delays = options.delays || (isCoordinatorMode() ? [0, 25, 75, 150] : [0, 50, 150, 300]);
  const requireFocusedWindow = options.requireFocusedWindow ?? true;

  for (const delay of delays) {
    const timer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
        return;
      }

      if (requireFocusedWindow && !mainWindow.isFocused()) {
        return;
      }

      sendTerminalBoundsCommand();
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
  log('window.create');

  mainWindow.once('ready-to-show', () => {
    log('window.ready-to-show');
    mainWindow.show();
    spawnTerminalHosts();
  });

  mainWindow.on('focus', () => {
    log('window.focus', { isFocused: mainWindow.isFocused(), isMinimized: mainWindow.isMinimized() });
    focusTerminalHost('electron-focus');
  });
  mainWindow.on('show', () => {
    log('window.show');
    sendTerminalBoundsCommand();
    focusTerminalHost('electron-show');
  });
  mainWindow.on('resize', () => {
    log('window.resize', { contentSize: mainWindow.getContentSize(), bounds: mainWindow.getBounds(), minimized: mainWindow.isMinimized() });
    scheduleTerminalBoundsCommand('resize');
  });
  mainWindow.on('move', () => {
    log('window.move', { bounds: mainWindow.getBounds(), minimized: mainWindow.isMinimized() });
    scheduleTerminalBoundsCommand('move');
  });
  mainWindow.on('blur', () => {
    log('window.blur', { isFocused: mainWindow.isFocused(), isMinimized: mainWindow.isMinimized() });
    sendTerminalBlurCommand('electron-blur');
  });
  mainWindow.on('minimize', () => {
    log('window.minimize');
    if (pendingBoundsTimer) {
      clearTimeout(pendingBoundsTimer);
      pendingBoundsTimer = undefined;
    }
    sendTerminalBlurCommand('electron-minimize');
  });

  mainWindow.on('restore', () => {
    log('window.restore', { isFocused: mainWindow.isFocused(), isMinimized: mainWindow.isMinimized() });
    // The native child HWND can need a nudge after parent minimize/restore.
    // The native host also polls the parent bounds, but this gives Windows a
    // fresh child-window layout event from the Electron side.
    if (liveTerminalHosts().length > 0) {
      mainWindow.focus();
      mainWindow.setSize(...mainWindow.getSize());
      sendTerminalBoundsCommand();
      focusTerminalHost('electron-restore', {
        delays: isCoordinatorMode() ? [0, 25, 75, 150] : [0, 50, 150, 300],
        requireFocusedWindow: false,
      });
    }
  });

  mainWindow.on('closed', () => {
    log('window.closed');
    clearPendingFocusTimers();
    if (pendingBoundsTimer) {
      clearTimeout(pendingBoundsTimer);
      pendingBoundsTimer = undefined;
    }
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
