import { startRendererApp } from './renderer/app';

const rendererApp = startRendererApp({
  bootstrap: window.neoncodeDesktop.config,
});

window.neoncodeDesktop.onPrepareClose(async () => {
  try {
    await rendererApp.prepareToClose();
  } catch (error) {
    console.error('prepare_close_failed', error);
  }
});
