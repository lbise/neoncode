const { app, BrowserWindow, Menu, clipboard, ipcMain, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let logFilePath;
let allowWindowClose = false;
let closeRequestInFlight = false;
let closeTimeout;

const hubCapabilityToken = process.env.NEONCODE_HUB_TOKEN;
if (!/^[0-9a-fA-F]{64}$/.test(hubCapabilityToken || '')) {
  throw new Error('NEONCODE_HUB_TOKEN must contain exactly 64 hexadecimal characters');
}

function rendererConfig() {
  return {
    NEONCODE_HUB_ENDPOINT: process.env.NEONCODE_HUB_ENDPOINT,
    NEONCODE_HUB_TOKEN: hubCapabilityToken,
    NEONCODE_PERSIST_SESSIONS: process.env.NEONCODE_PERSIST_SESSIONS,
    NEONCODE_SESSION_PREFIX: process.env.NEONCODE_SESSION_PREFIX,
    NEONCODE_TERMINAL_COUNT: process.env.NEONCODE_TERMINAL_COUNT,
    NEONCODE_TEST_MODE: process.env.NEONCODE_TEST_MODE,
  };
}

ipcMain.on('neoncode:get-renderer-config', (event) => {
  event.returnValue = rendererConfig();
});

ipcMain.handle('neoncode:read-clipboard-text', () => clipboard.readText());

function finishWindowClose(sender) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (sender && sender !== mainWindow.webContents) {
    return;
  }

  clearTimeout(closeTimeout);
  closeTimeout = undefined;
  allowWindowClose = true;
  mainWindow.close();
}

ipcMain.on('neoncode:close-ready', (event) => {
  finishWindowClose(event.sender);
});

function ensureLogFile() {
  if (logFilePath) {
    return logFilePath;
  }

  const logDir = path.join(app.getPath('temp'), 'NeonCode');
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'electron-app-main.log');
  fs.appendFileSync(logFilePath, `\n=== NeonCode Electron app start ${new Date().toISOString()} pid=${process.pid} ===\n`);
  return logFilePath;
}

function log(message, details) {
  try {
    const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    fs.appendFileSync(ensureLogFile(), `${new Date().toISOString()} ${message}${payload}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function configureSessionSecurity() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const testMode = process.env.NEONCODE_TEST_MODE === '1';
  const indexPath = path.join(__dirname, 'index.html');
  const appUrl = pathToFileURL(indexPath).toString();
  allowWindowClose = false;
  closeRequestInFlight = false;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0c0c0c',
    title: 'NeonCode',
    show: !testMode,
    webPreferences: {
      backgroundThrottling: !testMode,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
      log('navigation.blocked', { url });
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
      log('redirect.blocked', { url });
    }
  });

  mainWindow.loadFile(indexPath);
  log('window.create');

  mainWindow.webContents.once('did-finish-load', () => {
    log('window.did-finish-load');
  });
  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    log('window.did-fail-load', { errorCode, errorDescription });
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('renderer.console', { level, message, line, sourceId });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer.gone', details);
  });
  mainWindow.on('focus', () => log('window.focus'));
  mainWindow.on('blur', () => log('window.blur'));
  mainWindow.on('resize', () => log('window.resize', { contentSize: mainWindow.getContentSize() }));
  mainWindow.on('close', (event) => {
    if (allowWindowClose) {
      return;
    }

    event.preventDefault();
    if (closeRequestInFlight) {
      return;
    }

    closeRequestInFlight = true;
    log('window.prepare-close');
    closeTimeout = setTimeout(() => {
      log('window.prepare-close-timeout');
      finishWindowClose();
    }, 3000);
    if (mainWindow.webContents.isDestroyed()) {
      finishWindowClose();
    } else {
      mainWindow.webContents.send('neoncode:prepare-close');
    }
  });
  mainWindow.on('closed', () => {
    clearTimeout(closeTimeout);
    closeTimeout = undefined;
    log('window.closed');
    mainWindow = undefined;
  });
}

app.whenReady().then(() => {
  configureSessionSecurity();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
