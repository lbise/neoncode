const { app, BrowserWindow, Menu, clipboard, ipcMain, screen, session } = require('electron');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

const { ConfigStore, defaultState } = require('./config-store');
const { loadHubToken } = require('./token-loader');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setName('NeonCode');

const testMode = process.env.NEONCODE_TEST_MODE === '1';
const hubTokenResult = loadHubToken();
const hubCapabilityToken = hubTokenResult.token;

function resolveConfigDirectory() {
  const testDirectory = process.env.NEONCODE_TEST_CONFIG_DIR;
  if (testDirectory) {
    if (!testMode) {
      throw new Error('NEONCODE_TEST_CONFIG_DIR is allowed only when NEONCODE_TEST_MODE=1');
    }
    if (!path.isAbsolute(testDirectory)) {
      throw new Error('NEONCODE_TEST_CONFIG_DIR must be absolute');
    }
    return path.normalize(testDirectory);
  }
  return path.join(app.getPath('appData'), 'NeonCode');
}

const configDirectory = resolveConfigDirectory();
fs.mkdirSync(configDirectory, { recursive: true });
app.setPath('userData', configDirectory);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let configStore;
let desktopState = defaultState();
let bootstrapResult = {
  config: null,
  state: desktopState,
  diagnostics: {
    configStatus: 'error',
    stateStatus: 'error',
    warnings: [],
    errors: ['another NeonCode instance already owns the configuration directory'],
  },
};
if (hasSingleInstanceLock) {
  configStore = new ConfigStore(configDirectory);
  try {
    bootstrapResult = configStore.load(process.env);
    desktopState = bootstrapResult.state;
  } catch (error) {
    bootstrapResult = {
      config: null,
      state: desktopState,
      diagnostics: {
        configStatus: 'error',
        stateStatus: 'error',
        warnings: [],
        errors: [`configuration storage failed: ${error.message}`],
      },
    };
  }
}

let mainWindow;
let logFilePath;
let allowWindowClose = false;
let closeRequestInFlight = false;
let closeTimeout;
let stateSaveTimeout;

function processIntegrityLevel() {
  const result = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true });
  const match = (result.stdout || '').match(/Mandatory Label\\(Low|Medium|High|System) Mandatory Level/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function rendererConfig() {
  const config = bootstrapResult.config;
  const configuredWorkspaceIds = new Set((config?.workspaces || []).map((workspace) => workspace.id));
  const activeWorkspaceId = configuredWorkspaceIds.has(desktopState.activeWorkspaceId)
    ? desktopState.activeWorkspaceId
    : config?.workspaces[0]?.id || null;
  return {
    schemaVersion: config?.schemaVersion || 4,
    configurationValid: Boolean(config),
    endpoint: config?.hub.endpoint || '',
    capabilityToken: hubCapabilityToken,
    sessionPrefix: config?.sessionPrefix || '',
    persistencePolicy: config?.persistence.onWindowClose || 'detach',
    terminal: config ? JSON.parse(JSON.stringify(config.terminal)) : null,
    activeWorkspaceId,
    workspaces: config
      ? config.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        layout: { ...workspace.layout },
        sessions: workspace.sessions.map((configuredSession) => ({
          id: configuredSession.id,
          title: configuredSession.title,
          launchProfile: { ...config.launchProfiles[configuredSession.launchProfile] },
        })),
      }))
      : [],
    diagnostics: {
      configStatus: bootstrapResult.diagnostics.configStatus,
      stateStatus: bootstrapResult.diagnostics.stateStatus,
      warnings: [...bootstrapResult.diagnostics.warnings],
      errors: [...bootstrapResult.diagnostics.errors],
    },
    testMode,
  };
}

ipcMain.on('neoncode:get-renderer-config', (event) => {
  event.returnValue = rendererConfig();
});

ipcMain.handle('neoncode:read-clipboard-text', () => clipboard.readText());
ipcMain.handle('neoncode:set-active-workspace', (_event, workspaceId) => {
  const workspaces = bootstrapResult.config?.workspaces || [];
  if (typeof workspaceId !== 'string' || !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error('active workspace must reference a configured workspace');
  }
  desktopState = configStore.saveState({ ...desktopState, activeWorkspaceId: workspaceId });
  log('state.active-workspace', { workspaceId });
  return workspaceId;
});

ipcMain.handle('neoncode:write-clipboard-text', (_event, text) => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new Error('clipboard text must be a string no larger than 1 MiB');
  }
  clipboard.writeText(text);
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

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  clearTimeout(stateSaveTimeout);
  stateSaveTimeout = undefined;
  const [width, height] = mainWindow.getContentSize();
  try {
    desktopState = configStore.saveState({
      ...desktopState,
      schemaVersion: 2,
      window: { width, height },
    });
    log('state.saved', desktopState.window);
  } catch (error) {
    log('state.save-failed', { message: error.message });
  }
}

function scheduleWindowStateSave() {
  clearTimeout(stateSaveTimeout);
  stateSaveTimeout = setTimeout(saveWindowState, 250);
}

function restoredWindowSize() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(desktopState.window.width, workArea.width),
    height: Math.min(desktopState.window.height, workArea.height),
  };
}

function finishWindowClose(sender) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (sender && sender !== mainWindow.webContents) {
    return;
  }

  clearTimeout(closeTimeout);
  closeTimeout = undefined;
  saveWindowState();
  allowWindowClose = true;
  mainWindow.close();
}

ipcMain.on('neoncode:close-ready', (event) => {
  finishWindowClose(event.sender);
});

function configureSessionSecurity() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const indexPath = path.join(__dirname, '..', 'index.html');
  const appUrl = pathToFileURL(indexPath).toString();
  const windowSize = restoredWindowSize();
  allowWindowClose = false;
  closeRequestInFlight = false;

  mainWindow = new BrowserWindow({
    ...windowSize,
    useContentSize: true,
    minWidth: 800,
    minHeight: 600,
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
  log('window.create', {
    configStatus: bootstrapResult.diagnostics.configStatus,
    stateStatus: bootstrapResult.diagnostics.stateStatus,
    warnings: bootstrapResult.diagnostics.warnings,
    errors: bootstrapResult.diagnostics.errors,
    hubTokenSource: hubTokenResult.source,
    integrityLevel: processIntegrityLevel(),
  });

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
  mainWindow.on('resize', () => {
    log('window.resize', { contentSize: mainWindow.getContentSize() });
    scheduleWindowStateSave();
  });
  mainWindow.on('close', (event) => {
    if (allowWindowClose) {
      return;
    }

    event.preventDefault();
    if (closeRequestInFlight) {
      return;
    }

    closeRequestInFlight = true;
    saveWindowState();
    log('window.prepare-close');
    closeTimeout = setTimeout(() => {
      log('window.prepare-close-timeout');
      finishWindowClose();
    }, 5000);
    if (mainWindow.webContents.isDestroyed()) {
      finishWindowClose();
    } else {
      mainWindow.webContents.send('neoncode:prepare-close');
    }
  });
  mainWindow.on('closed', () => {
    clearTimeout(closeTimeout);
    clearTimeout(stateSaveTimeout);
    closeTimeout = undefined;
    stateSaveTimeout = undefined;
    log('window.closed');
    mainWindow = undefined;
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !testMode) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    configureSessionSecurity();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
