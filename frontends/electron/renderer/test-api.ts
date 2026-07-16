import type {
  CommandExecutionArguments,
  CommandOperationResult,
  RendererPublicState,
  RendererTestApi,
} from '../shared/types';
import type { NeonCodeApp } from './app';
import type { TerminalPane } from './terminal-pane';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findPane(app: NeonCodeApp, paneId: string): TerminalPane {
  const pane = app.panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) throw new Error(`unknown test pane: ${paneId}`);
  return pane;
}

export function installRendererTestApi(app: NeonCodeApp): RendererTestApi {
  const api: RendererTestApi = Object.freeze({
    getState(): RendererPublicState {
      return cloneJson(app.sessionModel.publicState);
    },

    async executeCommand(...command: CommandExecutionArguments): Promise<CommandOperationResult> {
      return app.executeCommand(...command);
    },

    listCommands() {
      return cloneJson(app.listCommands());
    },

    sendText(paneId: string, text: string): void {
      const sent = findPane(app, paneId).sendTerminalText(text, 'test_api');
      if (!sent) throw new Error(`test input was not sent for pane: ${paneId}`);
    },

    pasteText(paneId: string, text: string): void {
      const sent = findPane(app, paneId).pasteText(text, 'test_api');
      if (!sent) throw new Error(`test paste was not sent for pane: ${paneId}`);
    },

    async killPane(paneId: string): Promise<void> {
      await findPane(app, paneId).killAndClose();
    },

    async switchWorkspace(workspaceId: string): Promise<void> {
      await app.executeCommand('workspace.open', { workspaceId });
    },

    async acknowledgeWorkspaceAttention(workspaceId: string): Promise<void> {
      await app.executeCommand('workspace.dismissAttention', { workspaceId });
    },

    disconnectPaneSocket(paneId: string): void {
      findPane(app, paneId).forceDisconnectForTest();
    },

    selectAll(paneId: string): void {
      findPane(app, paneId).state.terminal.selectAll();
    },

    simulatePasteShortcutRace(paneId: string, text: string): void {
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
