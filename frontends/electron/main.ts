import { spawnSync } from 'node:child_process';
import fs = require('node:fs');
import path = require('node:path');
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  screen,
  session,
  type WebContents,
} from 'electron';

import {
  CONFIG_SCHEMA_VERSION,
  ConfigStore,
  STATE_SCHEMA_VERSION,
  applyEnvironmentOverrides,
  defaultState,
  settingsFromConfig,
} from './config-store';
import { manageHubLifecycle, type ManageHubLifecycleOptions } from './hub-manager';
import { validateWorkspaceLayoutState } from './shared/layout-model';
import type {
  DesktopBootstrapResult,
  DesktopState,
  RendererBootstrapConfig,
  RendererBootstrapWorkspace,
  SaveSettingsRequest,
  SaveWorkspaceCatalogRequest,
  SettingsSnapshot,
  TerminalAppearance,
  AppTheme,
  WorkspaceCatalogSnapshot,
} from './shared/types';
import type { WorkspaceLayoutState } from './shared/layout-model';
import { loadHubToken, type HubTokenResult } from './token-loader';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setName('NeonCode');

const testMode = process.env.NEONCODE_TEST_MODE === '1';
let hubTokenResult: HubTokenResult | null = null;
let hubTokenError: string | null = null;
try {
  hubTokenResult = loadHubToken();
} catch (error) {
  hubTokenError = errorMessage(error);
}
const hubCapabilityToken = hubTokenResult?.token ?? '';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveConfigDirectory(): string {
  const testDirectory: unknown = process.env.NEONCODE_TEST_CONFIG_DIR;
  if (testDirectory) {
    if (!testMode) {
      throw new Error('NEONCODE_TEST_CONFIG_DIR is allowed only when NEONCODE_TEST_MODE=1');
    }
    if (typeof testDirectory !== 'string' || !path.isAbsolute(testDirectory)) {
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
let configStore: ConfigStore | undefined;
let desktopState: DesktopState = defaultState();
let bootstrapResult: DesktopBootstrapResult = {
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
        errors: [`configuration storage failed: ${errorMessage(error)}`],
      },
    };
  }
  if (hubTokenError) {
    bootstrapResult.diagnostics.hubStatus = 'error';
    bootstrapResult.diagnostics.errors.push(`hub token setup failed: ${hubTokenError}`);
  }
}

let mainWindow: BrowserWindow | undefined;
let logFilePath: string | undefined;
let allowWindowClose = false;
let closeRequestInFlight = false;
let closeTimeout: ReturnType<typeof setTimeout> | undefined;
let stateSaveTimeout: ReturnType<typeof setTimeout> | undefined;
let configRevision = 1;

function processIntegrityLevel(): string {
  const result = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true });
  const match = (result.stdout || '').match(/Mandatory Label\\(Low|Medium|High|System) Mandatory Level/i);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function cloneTerminalAppearance(appearance: TerminalAppearance): TerminalAppearance {
  return {
    ...appearance,
    theme: { ...appearance.theme },
  };
}

function cloneAppTheme(theme: AppTheme): AppTheme {
  return { ...theme };
}

function rendererWorkspaces(): RendererBootstrapWorkspace[] {
  const config = bootstrapResult.config;
  if (!config) return [];
  return config.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    defaultLaunchProfile: workspace.defaultLaunchProfile,
    layout: { ...workspace.layout },
    sessions: workspace.sessions.map((configuredSession) => {
      const launchProfile = config.launchProfiles[configuredSession.launchProfile];
      if (!launchProfile) {
        throw new Error(`validated launch profile is missing: ${configuredSession.launchProfile}`);
      }
      return {
        id: configuredSession.id,
        title: configuredSession.title,
        launchProfileId: configuredSession.launchProfile,
        launchProfile: {
          ...launchProfile,
          args: [...launchProfile.args],
          cwd: workspace.path ?? launchProfile.cwd,
        },
      };
    }),
  }));
}

function rendererWorkspaceLayouts(): Record<string, WorkspaceLayoutState> {
  return Object.fromEntries(Object.entries(desktopState.workspaceLayouts).map(([workspaceId, layout]) => (
    [workspaceId, validateWorkspaceLayoutState(layout)]
  )));
}

function rendererConfig(): RendererBootstrapConfig {
  const config = bootstrapResult.config;
  const configuredWorkspaceIds = new Set((config?.workspaces || []).map((workspace) => workspace.id));
  const activeWorkspaceId = configuredWorkspaceIds.has(desktopState.activeWorkspaceId ?? '')
    ? desktopState.activeWorkspaceId
    : config?.workspaces[0]?.id || null;
  return {
    schemaVersion: config?.schemaVersion || CONFIG_SCHEMA_VERSION,
    configurationValid: Boolean(config),
    endpoint: config?.hub.endpoint || '',
    capabilityToken: hubCapabilityToken,
    sessionPrefix: config?.sessionPrefix || '',
    persistencePolicy: config?.persistence.onWindowClose || 'detach',
    confirmBeforeClosingTab: config?.persistence.confirmBeforeClosingTab ?? false,
    confirmBeforeClosingTerminal: config?.persistence.confirmBeforeClosingTerminal ?? false,
    terminal: config ? cloneTerminalAppearance(config.terminal) : null,
    appTheme: config ? cloneAppTheme(config.appTheme) : null,
    keybindingOverrides: config ? structuredClone(config.keybindings.overrides) : [],
    activeWorkspaceId,
    workspaceLayouts: rendererWorkspaceLayouts(),
    launchProfiles: config ? structuredClone(config.launchProfiles) : {},
    workspaces: rendererWorkspaces(),
    diagnostics: {
      configStatus: bootstrapResult.diagnostics.configStatus,
      stateStatus: bootstrapResult.diagnostics.stateStatus,
      warnings: [...bootstrapResult.diagnostics.warnings],
      errors: [...bootstrapResult.diagnostics.errors],
      hubStatus: bootstrapResult.diagnostics.hubStatus ?? 'not_checked',
    },
    testMode,
  };
}

ipcMain.on('neoncode:get-renderer-config', (event) => {
  event.returnValue = rendererConfig();
});

function addDiagnosticWarning(warning: string): void {
  if (!bootstrapResult.diagnostics.warnings.includes(warning)) {
    bootstrapResult.diagnostics.warnings.push(warning);
  }
}

function addDiagnosticError(error: string): void {
  if (!bootstrapResult.diagnostics.errors.includes(error)) {
    bootstrapResult.diagnostics.errors.push(error);
  }
}

async function prepareManagedHubLifecycle(): Promise<void> {
  const endpoint = bootstrapResult.config?.hub.endpoint;
  if (!endpoint) {
    bootstrapResult.diagnostics.hubStatus = 'not_configured';
    return;
  }

  const options: ManageHubLifecycleOptions = {
    endpoint,
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
  };
  const buildSha = process.env.NEONCODE_BUILD_GIT_SHA;
  if (buildSha) options.appSha = buildSha;

  try {
    const result = await manageHubLifecycle(options);
    bootstrapResult.diagnostics.hubStatus = result.status;
    for (const warning of result.warnings) addDiagnosticWarning(`hub manager: ${warning}`);
    for (const error of result.errors) addDiagnosticError(`hub manager: ${error}`);
    log('hub-manager.result', result);
  } catch (error) {
    const message = `hub manager failed unexpectedly: ${errorMessage(error)}`;
    bootstrapResult.diagnostics.hubStatus = 'error';
    addDiagnosticError(message);
    log('hub-manager.unhandled-error', { message: errorMessage(error) });
  }
}

function requireCurrentRenderer(sender: WebContents): BrowserWindow {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()
      || sender !== window.webContents) {
    throw new Error('settings IPC sender is not the current NeonCode window');
  }
  return window;
}

ipcMain.handle('neoncode:get-settings', (event): SettingsSnapshot => {
  requireCurrentRenderer(event.sender);
  if (!configStore) throw new Error('configuration storage is unavailable');
  return {
    revision: configRevision,
    settings: configStore.getStoredSettings(),
  };
});

ipcMain.handle('neoncode:save-settings', (event, request: unknown): SettingsSnapshot => {
  requireCurrentRenderer(event.sender);
  if (!configStore) throw new Error('configuration storage is unavailable');
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('settings save request must be an object');
  }
  const document = request as Partial<SaveSettingsRequest> & Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== 'revision' || keys[1] !== 'settings') {
    throw new Error('settings save request keys must be exactly: revision, settings');
  }
  if (!Number.isSafeInteger(document.revision) || document.revision !== configRevision) {
    throw new Error('settings have changed; reopen Settings and try again');
  }
  const saved = configStore.saveSettings(document.settings);
  const effective = applyEnvironmentOverrides(saved, process.env);
  bootstrapResult = {
    ...bootstrapResult,
    config: effective,
  };
  configRevision += 1;
  log('settings.saved', { revision: configRevision });
  return {
    revision: configRevision,
    settings: settingsFromConfig(saved),
  };
});

ipcMain.handle('neoncode:get-workspace-catalog', (event): WorkspaceCatalogSnapshot => {
  requireCurrentRenderer(event.sender);
  if (!configStore) throw new Error('configuration storage is unavailable');
  return {
    revision: configRevision,
    workspaces: configStore.getStoredWorkspaces(),
  };
});

ipcMain.handle('neoncode:save-workspace-catalog', (event, request: unknown): WorkspaceCatalogSnapshot => {
  requireCurrentRenderer(event.sender);
  if (!configStore) throw new Error('configuration storage is unavailable');
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('workspace catalog save request must be an object');
  }
  const document = request as Partial<SaveWorkspaceCatalogRequest> & Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== 'revision' || keys[1] !== 'workspaces') {
    throw new Error('workspace catalog save request keys must be exactly: revision, workspaces');
  }
  if (!Number.isSafeInteger(document.revision) || document.revision !== configRevision) {
    throw new Error('configuration has changed; retry the workspace operation');
  }
  const saved = configStore.saveWorkspaceCatalog(document.workspaces);
  const effective = applyEnvironmentOverrides(saved, process.env);
  bootstrapResult = { ...bootstrapResult, config: effective };
  configRevision += 1;

  const workspaceIds = new Set(saved.workspaces.map((workspace) => workspace.id));
  const reconciledState: DesktopState = {
    ...desktopState,
    activeWorkspaceId: workspaceIds.has(desktopState.activeWorkspaceId ?? '')
      ? desktopState.activeWorkspaceId
      : null,
    workspaceLayouts: Object.fromEntries(
      Object.entries(desktopState.workspaceLayouts)
        .filter(([workspaceId]) => workspaceIds.has(workspaceId)),
    ),
  };
  try {
    desktopState = configStore.saveState(reconciledState);
  } catch (error) {
    desktopState = reconciledState;
    const warning = `workspace state reconciliation could not be persisted: ${errorMessage(error)}`;
    if (!bootstrapResult.diagnostics.warnings.includes(warning)) {
      bootstrapResult.diagnostics.warnings.push(warning);
    }
    log('state.workspace-catalog-reconcile-failed', { message: errorMessage(error) });
  }
  log('workspace-catalog.saved', { revision: configRevision, count: saved.workspaces.length });
  return {
    revision: configRevision,
    workspaces: structuredClone(saved.workspaces),
  };
});

ipcMain.handle('neoncode:read-clipboard-text', () => clipboard.readText());
ipcMain.handle('neoncode:set-active-workspace', (_event, workspaceId: unknown) => {
  const workspaces = bootstrapResult.config?.workspaces || [];
  if (typeof workspaceId !== 'string' || !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error('active workspace must reference a configured workspace');
  }
  if (!configStore) {
    throw new Error('configuration storage is unavailable');
  }
  desktopState = configStore.saveState({ ...desktopState, activeWorkspaceId: workspaceId });
  log('state.active-workspace', { workspaceId });
  return workspaceId;
});

ipcMain.handle('neoncode:save-workspace-layout', (_event, workspaceId: unknown, layout: unknown) => {
  const workspaces = bootstrapResult.config?.workspaces || [];
  if (typeof workspaceId !== 'string' || !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error('workspace layout must reference a configured workspace');
  }
  if (!configStore) {
    throw new Error('configuration storage is unavailable');
  }
  const validatedLayout = validateWorkspaceLayoutState(layout);
  const savedState = configStore.saveState({
    ...desktopState,
    workspaceLayouts: {
      ...desktopState.workspaceLayouts,
      [workspaceId]: validatedLayout,
    },
  });
  desktopState = savedState;
  log('state.workspace-layout', { workspaceId });
});

ipcMain.handle('neoncode:write-clipboard-text', (_event, text: unknown) => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw new Error('clipboard text must be a string no larger than 1 MiB');
  }
  clipboard.writeText(text);
});

function ensureLogFile(): string {
  if (logFilePath) {
    return logFilePath;
  }

  const logDir = path.join(app.getPath('temp'), 'NeonCode');
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'electron-app-main.log');
  fs.appendFileSync(
    logFilePath,
    `\n=== NeonCode Electron app start ${new Date().toISOString()} pid=${process.pid} ===\n`,
  );
  return logFilePath;
}

function log(message: string, details?: unknown): void {
  try {
    const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    fs.appendFileSync(ensureLogFile(), `${new Date().toISOString()} ${message}${payload}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function saveWindowState(): void {
  const window = mainWindow;
  const store = configStore;
  if (!window || window.isDestroyed() || !store) {
    return;
  }
  clearTimeout(stateSaveTimeout);
  stateSaveTimeout = undefined;
  const [width, height] = window.getContentSize();
  try {
    desktopState = store.saveState({
      ...desktopState,
      schemaVersion: STATE_SCHEMA_VERSION,
      window: { width, height },
    });
    log('state.saved', desktopState.window);
  } catch (error) {
    log('state.save-failed', { message: errorMessage(error) });
  }
}

function scheduleWindowStateSave(): void {
  clearTimeout(stateSaveTimeout);
  stateSaveTimeout = setTimeout(saveWindowState, 250);
}

function restoredWindowSize(): { width: number; height: number } {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(desktopState.window.width, workArea.width),
    height: Math.min(desktopState.window.height, workArea.height),
  };
}

function finishWindowClose(sender?: WebContents): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }
  if (sender && sender !== window.webContents) {
    return;
  }

  clearTimeout(closeTimeout);
  closeTimeout = undefined;
  saveWindowState();
  allowWindowClose = true;
  window.close();
}

ipcMain.on('neoncode:close-ready', (event) => {
  finishWindowClose(event.sender);
});

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function createWindow(): void {
  Menu.setApplicationMenu(null);
  const indexPath = path.join(__dirname, '..', 'index.html');
  const appUrl = pathToFileURL(indexPath).toString();
  const windowSize = restoredWindowSize();
  allowWindowClose = false;
  closeRequestInFlight = false;

  const window = new BrowserWindow({
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
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
      log('navigation.blocked', { url });
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
      log('redirect.blocked', { url });
    }
  });

  void window.loadFile(indexPath);
  log('window.create', {
    configStatus: bootstrapResult.diagnostics.configStatus,
    stateStatus: bootstrapResult.diagnostics.stateStatus,
    warnings: bootstrapResult.diagnostics.warnings,
    errors: bootstrapResult.diagnostics.errors,
    hubTokenSource: hubTokenResult?.source ?? 'unavailable',
    integrityLevel: processIntegrityLevel(),
  });

  window.webContents.once('did-finish-load', () => {
    log('window.did-finish-load');
  });
  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    log('window.did-fail-load', { errorCode, errorDescription });
  });
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('renderer.console', { level, message, line, sourceId });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log('renderer.gone', details);
  });
  window.on('focus', () => log('window.focus'));
  window.on('blur', () => log('window.blur'));
  window.on('resize', () => {
    log('window.resize', { contentSize: window.getContentSize() });
    scheduleWindowStateSave();
  });
  window.on('close', (event) => {
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
    if (window.webContents.isDestroyed()) {
      finishWindowClose();
    } else {
      window.webContents.send('neoncode:prepare-close');
    }
  });
  window.on('closed', () => {
    clearTimeout(closeTimeout);
    clearTimeout(stateSaveTimeout);
    closeTimeout = undefined;
    stateSaveTimeout = undefined;
    log('window.closed');
    if (mainWindow === window) {
      mainWindow = undefined;
    }
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

  void app.whenReady().then(async () => {
    configureSessionSecurity();
    await prepareManagedHubLifecycle();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
