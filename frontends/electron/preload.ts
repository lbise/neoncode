import { contextBridge, ipcRenderer } from 'electron';

import { validateWorkspaceLayoutState } from './shared/layout-model';
import type { WorkspaceLayoutState } from './shared/layout-model';
import type { NeoncodeDesktopApi, PrepareCloseCallback } from './shared/types';

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
  ): Promise<WorkspaceLayoutState> {
    const savedLayout: unknown = await ipcRenderer.invoke(
      'neoncode:save-workspace-layout',
      workspaceId,
      layout,
    );
    return deepFreeze(validateWorkspaceLayoutState(savedLayout));
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
