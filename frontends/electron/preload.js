const { contextBridge, ipcRenderer } = require('electron');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

const config = deepFreeze(ipcRenderer.sendSync('neoncode:get-renderer-config'));

contextBridge.exposeInMainWorld('neoncodeDesktop', Object.freeze({
  config,

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
