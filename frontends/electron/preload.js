const { contextBridge, ipcRenderer } = require('electron');

const config = ipcRenderer.sendSync('neoncode:get-renderer-config');

contextBridge.exposeInMainWorld('neoncodeDesktop', Object.freeze({
  config: Object.freeze(config),

  readClipboardText() {
    return ipcRenderer.invoke('neoncode:read-clipboard-text');
  },

  onPrepareClose(callback) {
    ipcRenderer.on('neoncode:prepare-close', async () => {
      try {
        await callback();
      } finally {
        ipcRenderer.send('neoncode:close-ready');
      }
    });
  },
}));
