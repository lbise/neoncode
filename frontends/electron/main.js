const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');

let mainWindow;
let logFilePath;
let allowWindowClose = false;
let closeRequestInFlight = false;
let closeTimeout;

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

function createWindow() {
  Menu.setApplicationMenu(null);
  const testMode = process.env.NEONCODE_TEST_MODE === '1';
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
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
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
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
