import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { WorkspaceLayoutState } from './shared/layout-model';
import type {
  ConfigChangedCallback,
  NeoncodeDesktopApi,
  PrepareCloseCallback,
  SaveSettingsRequest,
  SaveWorkspaceCatalogRequest,
  SettingsSnapshot,
  WorkspaceCatalogSnapshot,
} from './shared/types';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function isPrepareCloseCallback(value: unknown): value is PrepareCloseCallback {
  return typeof value === 'function';
}

function isConfigChangedCallback(value: unknown): value is ConfigChangedCallback {
  return typeof value === 'function';
}

function workspaceCatalogSnapshot(value: unknown): WorkspaceCatalogSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace catalog IPC returned an invalid response');
  }
  const response = value as { revision?: unknown; workspaces?: unknown };
  if (!Number.isSafeInteger(response.revision) || !Array.isArray(response.workspaces)) {
    throw new Error('workspace catalog IPC returned an invalid response');
  }
  return structuredClone(value) as WorkspaceCatalogSnapshot;
}

function settingsSnapshot(value: unknown): SettingsSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('settings IPC returned an invalid response');
  }
  const response = value as { revision?: unknown; settings?: unknown };
  if (!Number.isSafeInteger(response.revision)
      || response.settings === null || typeof response.settings !== 'object'
      || Array.isArray(response.settings)) {
    throw new Error('settings IPC returned an invalid response');
  }
  return structuredClone(value) as SettingsSnapshot;
}

const bootstrap: unknown = ipcRenderer.sendSync('neoncode:get-renderer-config');
const config = deepFreeze(bootstrap);

const desktopApi = Object.freeze({
  config,

  async readClipboardText(): Promise<string> {
    const text: unknown = await ipcRenderer.invoke('neoncode:read-clipboard-text');
    if (typeof text !== 'string') {
      throw new Error('clipboard IPC returned a non-string value');
    }
    return text;
  },

  async writeClipboardText(text: string): Promise<void> {
    await ipcRenderer.invoke('neoncode:write-clipboard-text', text);
  },

  async setActiveWorkspace(workspaceId: string): Promise<string> {
    const activeWorkspaceId: unknown = await ipcRenderer.invoke(
      'neoncode:set-active-workspace',
      workspaceId,
    );
    if (typeof activeWorkspaceId !== 'string') {
      throw new Error('active-workspace IPC returned a non-string value');
    }
    return activeWorkspaceId;
  },

  async saveWorkspaceLayout(
    workspaceId: string,
    layout: WorkspaceLayoutState,
  ): Promise<void> {
    await ipcRenderer.invoke('neoncode:save-workspace-layout', workspaceId, layout);
  },

  async getSettings(): Promise<SettingsSnapshot> {
    return settingsSnapshot(await ipcRenderer.invoke('neoncode:get-settings'));
  },

  async saveSettings(request: SaveSettingsRequest): Promise<SettingsSnapshot> {
    return settingsSnapshot(await ipcRenderer.invoke(
      'neoncode:save-settings',
      structuredClone(request),
    ));
  },

  async getWorkspaceCatalog(): Promise<WorkspaceCatalogSnapshot> {
    return workspaceCatalogSnapshot(await ipcRenderer.invoke('neoncode:get-workspace-catalog'));
  },

  async saveWorkspaceCatalog(
    request: SaveWorkspaceCatalogRequest,
  ): Promise<WorkspaceCatalogSnapshot> {
    return workspaceCatalogSnapshot(await ipcRenderer.invoke(
      'neoncode:save-workspace-catalog',
      structuredClone(request),
    ));
  },

  onConfigChanged(callback: ConfigChangedCallback): () => void {
    if (!isConfigChangedCallback(callback)) {
      throw new TypeError('config-changed callback must be a function');
    }
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      void callback(deepFreeze(structuredClone(payload)) as Parameters<ConfigChangedCallback>[0]);
    };
    ipcRenderer.on('neoncode:config-changed', listener);
    return () => ipcRenderer.removeListener('neoncode:config-changed', listener);
  },

  onPrepareClose(callback: PrepareCloseCallback): void {
    if (!isPrepareCloseCallback(callback)) {
      throw new TypeError('prepare-close callback must be a function');
    }
    ipcRenderer.on('neoncode:prepare-close', async () => {
      try {
        await callback();
      } finally {
        ipcRenderer.send('neoncode:close-ready');
      }
    });
  },
} satisfies NeoncodeDesktopApi);

contextBridge.exposeInMainWorld('neoncodeDesktop', desktopApi);
