const { startRendererApp } = require('./renderer/app');

const rendererApp = startRendererApp({
  env: window.neoncodeDesktop.config,
});

window.neoncodeDesktop.onPrepareClose(async () => {
  try {
    await rendererApp.prepareToClose();
  } catch (error) {
    console.error('prepare_close_failed', error);
  }
});
