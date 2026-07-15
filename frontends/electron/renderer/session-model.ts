import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type {
  ActivationMode,
  ExitSummary,
  NormalizedSessionSummary,
  PaneState,
  PublicConfiguration,
  PublicPaneState,
  RendererPublicState,
  ReplayCheckpoint,
  SessionLifecycle,
  WorkspaceSummary,
} from '../shared/types';

export const MAX_RECENT_OUTPUT_CHARS = 32768;

interface WindowStateTarget {
  neoncodeXtermState?: RendererPublicState;
}

interface SessionModelOptions {
  windowRef?: WindowStateTarget;
}

interface CreatePaneStateOptions {
  index: number;
  paneId: string;
  sessionKey: string;
  sessionId: string;
  activationMode: ActivationMode;
  terminal: Terminal;
  fitAddon: FitAddon;
}

interface TerminalSize {
  rows: number;
  cols: number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionModel {
  readonly windowRef: WindowStateTarget;
  readonly publicState: RendererPublicState;

  constructor({ windowRef = window as WindowStateTarget }: SessionModelOptions = {}) {
    this.windowRef = windowRef;
    this.publicState = {
      configuration: {
        valid: false,
        configStatus: 'idle',
        stateStatus: 'idle',
        warnings: [],
        errors: [],
        persistencePolicy: 'detach',
        sessions: [],
      },
      panes: [],
      workspace: {
        activeWorkspaceId: null,
        summaries: [],
      },
      sessionDiscovery: {
        status: 'idle',
        sessionListEvents: 0,
        sessions: [],
        sessionSummaries: [],
        error: '',
      },
    };
    this.windowRef.neoncodeXtermState = this.publicState;
  }

  setConfiguration(configuration: PublicConfiguration): void {
    this.publicState.configuration = cloneJson(configuration);
  }

  addConfigurationWarning(warning: string): void {
    if (!this.publicState.configuration.warnings.includes(warning)) {
      this.publicState.configuration.warnings.push(warning);
    }
  }

  setWorkspaceSummaries(summaries: WorkspaceSummary[]): void {
    this.publicState.workspace.summaries = cloneJson(summaries);
  }

  setActiveWorkspace(workspaceId: string): void {
    this.publicState.workspace.activeWorkspaceId = workspaceId;
    this.publicState.configuration.activeWorkspaceId = workspaceId;
  }

  resetPanes(workspaceId: string): void {
    this.publicState.panes = [];
    this.setActiveWorkspace(workspaceId);
  }

  setSessionDiscoveryStatus(status: string, error = ''): void {
    this.publicState.sessionDiscovery.status = status;
    this.publicState.sessionDiscovery.error = error;
  }

  recordSessionList(summaries: NormalizedSessionSummary[]): void {
    this.publicState.sessionDiscovery.status = 'ready';
    this.publicState.sessionDiscovery.sessionListEvents += 1;
    this.publicState.sessionDiscovery.sessions = summaries.map((summary) => summary.sessionId);
    this.publicState.sessionDiscovery.sessionSummaries = cloneJson(summaries);
    this.publicState.sessionDiscovery.error = '';
  }

  createPaneState({
    index,
    paneId,
    sessionKey,
    sessionId,
    activationMode,
    terminal,
    fitAddon,
  }: CreatePaneStateOptions): PaneState {
    const state = {
      index,
      paneId,
      sessionKey,
      sessionId,
      activationMode,
      lifecycle: 'connecting',
      error: '',
      terminal,
      fitAddon,
      started: false,
      resizePending: false,
      outputEvents: 0,
      firstOutputSeq: 0,
      lastOutputSeq: 0,
      inputEvents: 0,
      resizeEvents: 0,
      lastRows: terminal.rows,
      lastCols: terminal.cols,
      suppressedPasteText: '',
      hubBootId: '',
      reconnectAttempts: 0,
      reconnectEvents: 0,
      latestExit: null,
      sessionInstanceId: '',
      replayTruncated: false,
      replayWarning: '',
      replayResetEvents: 0,
    } as PaneState;

    const theme = terminal.options.theme ?? {};
    const publicPane: PublicPaneState = {
      paneId,
      sessionKey,
      sessionId,
      activationMode,
      lifecycle: 'connecting',
      error: '',
      started: false,
      outputEvents: 0,
      firstOutputSeq: 0,
      lastOutputSeq: 0,
      outputGap: '',
      inputEvents: 0,
      resizeEvents: 0,
      recentOutput: '',
      rows: terminal.rows,
      cols: terminal.cols,
      hubBootId: '',
      reconnectAttempts: 0,
      reconnectEvents: 0,
      reconnectDelayMs: 0,
      fontFamily: terminal.options.fontFamily ?? '',
      fontSize: terminal.options.fontSize ?? 0,
      cursorBlink: terminal.options.cursorBlink ?? false,
      background: theme.background ?? '',
      magenta: theme.magenta ?? '',
      brightMagenta: theme.brightMagenta ?? '',
      latestExit: null,
      sessionInstanceId: '',
      replayTruncated: false,
      replayWarning: '',
      replayResetEvents: 0,
    };
    this.publicState.panes[index] = publicPane;
    state.publicPane = publicPane;

    return state;
  }

  pane(state: PaneState): PublicPaneState {
    return state.publicPane;
  }

  setPublicStarted(state: PaneState, started: boolean): void {
    this.pane(state).started = started;
  }

  setActivationMode(state: PaneState, activationMode: ActivationMode): void {
    state.activationMode = activationMode;
    this.pane(state).activationMode = activationMode;
  }

  setLifecycle(state: PaneState, lifecycle: SessionLifecycle, error = ''): void {
    state.lifecycle = lifecycle;
    state.error = error;
    const pane = this.pane(state);
    pane.lifecycle = lifecycle;
    pane.error = error;
  }

  updateSize(state: PaneState, { rows, cols }: TerminalSize): void {
    const pane = this.pane(state);
    pane.rows = rows;
    pane.cols = cols;
  }

  beginHubBoot(state: PaneState, bootId: string): void {
    if (state.hubBootId && state.hubBootId !== bootId && !state.sessionInstanceId) {
      state.firstOutputSeq = 0;
      state.lastOutputSeq = 0;
      const pane = this.pane(state);
      pane.firstOutputSeq = 0;
      pane.lastOutputSeq = 0;
      pane.outputGap = '';
    }
    state.hubBootId = bootId;
    this.pane(state).hubBootId = bootId;
  }

  applyReplayCheckpoint(state: PaneState, checkpoint: ReplayCheckpoint): void {
    const pane = this.pane(state);
    if (checkpoint.resetRequired) {
      const replayBaseline = Math.max(0, checkpoint.firstAvailableSeq - 1);
      state.firstOutputSeq = 0;
      state.lastOutputSeq = replayBaseline;
      state.outputEvents = 0;
      pane.firstOutputSeq = 0;
      pane.lastOutputSeq = replayBaseline;
      pane.outputEvents = 0;
      pane.outputGap = '';
      pane.recentOutput = '';
      pane.replayResetEvents += 1;
    }
    if (checkpoint.replayTruncated) {
      const beforeFirst = Math.max(0, checkpoint.firstAvailableSeq - 1);
      state.firstOutputSeq = 0;
      state.lastOutputSeq = beforeFirst;
      pane.firstOutputSeq = 0;
      pane.lastOutputSeq = beforeFirst;
      pane.outputGap = '';
    }
    pane.replayWarning = (checkpoint.replayTruncated
        || (checkpoint.resetRequired && checkpoint.firstAvailableSeq > 1))
      ? `Output before sequence ${checkpoint.firstAvailableSeq} is unavailable`
      : '';
    state.sessionInstanceId = checkpoint.instanceId;
    pane.sessionInstanceId = checkpoint.instanceId;
    pane.replayTruncated = checkpoint.replayTruncated;
  }

  setSessionInstance(state: PaneState, instanceId: unknown): void {
    if (typeof instanceId !== 'string' || !/^[0-9a-f]{32}$/.test(instanceId)) return;
    state.sessionInstanceId = instanceId;
    this.pane(state).sessionInstanceId = instanceId;
  }

  recordReconnect(state: PaneState, attempts: number, delayMs: number): void {
    state.reconnectAttempts = attempts;
    state.reconnectEvents += 1;
    const pane = this.pane(state);
    pane.reconnectAttempts = attempts;
    pane.reconnectEvents = state.reconnectEvents;
    pane.reconnectDelayMs = delayMs;
  }

  clearReconnect(state: PaneState): void {
    state.reconnectAttempts = 0;
    const pane = this.pane(state);
    pane.reconnectAttempts = 0;
    pane.reconnectDelayMs = 0;
  }

  recordExit(state: PaneState, outcome: ExitSummary): void {
    state.latestExit = { ...outcome };
    this.pane(state).latestExit = { ...outcome };
  }

  recordInput(state: PaneState): void {
    state.inputEvents += 1;
    this.pane(state).inputEvents = state.inputEvents;
  }

  recordOutput(state: PaneState, text: string, seq?: unknown): boolean {
    const outputSeq = typeof seq === 'number' && Number.isSafeInteger(seq)
      ? seq
      : state.lastOutputSeq + 1;
    if (outputSeq <= state.lastOutputSeq) {
      return false;
    }

    const pane = this.pane(state);
    if (state.lastOutputSeq > 0 && outputSeq !== state.lastOutputSeq + 1) {
      pane.outputGap = `${state.lastOutputSeq + 1}-${outputSeq - 1}`;
    }
    if (state.firstOutputSeq === 0) {
      state.firstOutputSeq = outputSeq;
      pane.firstOutputSeq = outputSeq;
    }
    state.lastOutputSeq = outputSeq;
    pane.lastOutputSeq = outputSeq;
    state.outputEvents += 1;
    pane.outputEvents = state.outputEvents;
    pane.recentOutput = (pane.recentOutput + text).slice(-MAX_RECENT_OUTPUT_CHARS);
    return true;
  }

  recordResize(state: PaneState): void {
    state.resizeEvents += 1;
    this.pane(state).resizeEvents = state.resizeEvents;
  }
}
