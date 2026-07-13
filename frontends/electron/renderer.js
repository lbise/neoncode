const { ipcRenderer } = require('electron');

const { startRendererApp } = require('./renderer/app');

const rendererApp = startRendererApp();
let closePreparation;

ipcRenderer.on('neoncode:prepare-close', () => {
  if (!closePreparation) {
    closePreparation = rendererApp.prepareToClose();
  }
  closePreparation
    .catch((error) => {
      console.error('prepare_close_failed', error);
    })
    .finally(() => {
      ipcRenderer.send('neoncode:close-ready');
    });
});
