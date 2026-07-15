function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function findPane(app, paneId) {
  const pane = app.panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) {
    throw new Error(`unknown test pane: ${paneId}`);
  }
  return pane;
}

function installRendererTestApi(app) {
  const api = Object.freeze({
    getState() {
      return cloneJson(app.sessionModel.publicState);
    },

    sendText(paneId, text) {
      const sent = findPane(app, paneId).sendTerminalText(text, 'test_api');
      if (!sent) {
        throw new Error(`test input was not sent for pane: ${paneId}`);
      }
    },

    pasteText(paneId, text) {
      const sent = findPane(app, paneId).pasteText(text, 'test_api');
      if (!sent) {
        throw new Error(`test paste was not sent for pane: ${paneId}`);
      }
    },

    async killPane(paneId) {
      await findPane(app, paneId).killAndClose();
    },

    async switchWorkspace(workspaceId) {
      await app.switchWorkspace(workspaceId);
    },

    async acknowledgeWorkspaceAttention(workspaceId) {
      await app.acknowledgeWorkspaceAttention(workspaceId);
    },

    disconnectPaneSocket(paneId) {
      findPane(app, paneId).forceDisconnectForTest();
    },

    selectAll(paneId) {
      findPane(app, paneId).state.terminal.selectAll();
    },

    simulatePasteShortcutRace(paneId, text) {
      const pane = findPane(app, paneId);
      pane.handlePasteShortcut();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      pane.container.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    },
  });

  app.window.neoncodeTest = api;
  return api;
}

module.exports = {
  installRendererTestApi,
};
