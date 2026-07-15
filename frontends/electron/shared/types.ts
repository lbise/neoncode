import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export type ActivationMode = 'attach' | 'start';
export type SessionLifecycle =
  | 'attached'
  | 'attaching'
  | 'connecting'
  | 'detached'
  | 'detaching'
  | 'error'
  | 'exited'
  | 'killed'
  | 'killing'
  | 'reconnecting'
  | 'started'
  | 'starting';
export type ExitReason = 'process_exit' | 'wait_failed' | 'killed';
export type SessionSummaryState = 'running' | 'exited';

export interface ExitSummary {
  attentionId: string | null;
  status: number | null;
  reason: ExitReason;
}

export interface RetainedExitSummary {
  attentionId: string;
  status: number | null;
  reason: ExitReason;
}

export interface NormalizedSessionSummary {
  sessionId: string;
  command: string | null;
  cwd: string | null;
  persistent: boolean | null;
  attachmentCount: number | null;
  metadataComplete: boolean;
  state: SessionSummaryState;
  latestExit: RetainedExitSummary | null;
  lifecycleComplete: boolean;
  instanceId: string | null;
  instanceComplete: boolean;
}

export interface ReplayCheckpoint {
  instanceId: string;
  firstAvailableSeq: number;
  replayThroughSeq: number;
  replayTruncated: boolean;
  resetRequired: boolean;
}

export interface HubWelcome {
  type: 'welcome';
  protocol_version: 1;
  boot_id: string;
  capabilities: string[];
  [key: string]: unknown;
}

export interface PublicConfiguration {
  valid: boolean;
  configStatus: string;
  stateStatus: string;
  warnings: string[];
  errors: string[];
  persistencePolicy: string;
  sessions: unknown[];
  activeWorkspaceId?: string | null;
  [key: string]: unknown;
}

export interface PublicPaneState {
  paneId: string;
  sessionKey: string;
  sessionId: string;
  activationMode: ActivationMode;
  lifecycle: SessionLifecycle;
  error: string;
  started: boolean;
  outputEvents: number;
  firstOutputSeq: number;
  lastOutputSeq: number;
  outputGap: string;
  inputEvents: number;
  resizeEvents: number;
  recentOutput: string;
  rows: number;
  cols: number;
  hubBootId: string;
  reconnectAttempts: number;
  reconnectEvents: number;
  reconnectDelayMs: number;
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  background: string;
  magenta: string;
  brightMagenta: string;
  latestExit: ExitSummary | null;
  sessionInstanceId: string;
  replayTruncated: boolean;
  replayWarning: string;
  replayResetEvents: number;
}

export interface RendererPublicState {
  configuration: PublicConfiguration;
  panes: PublicPaneState[];
  workspace: {
    activeWorkspaceId: string | null;
    summaries: unknown[];
  };
  sessionDiscovery: {
    status: string;
    sessionListEvents: number;
    sessions: string[];
    sessionSummaries: NormalizedSessionSummary[];
    error: string;
  };
}

export interface PaneState {
  index: number;
  paneId: string;
  sessionKey: string;
  sessionId: string;
  activationMode: ActivationMode;
  lifecycle: SessionLifecycle;
  error: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  started: boolean;
  resizePending: boolean;
  outputEvents: number;
  firstOutputSeq: number;
  lastOutputSeq: number;
  inputEvents: number;
  resizeEvents: number;
  lastRows: number;
  lastCols: number;
  suppressedPasteText: string;
  hubBootId: string;
  reconnectAttempts: number;
  reconnectEvents: number;
  latestExit: ExitSummary | null;
  sessionInstanceId: string;
  replayTruncated: boolean;
  replayWarning: string;
  replayResetEvents: number;
  publicPane: PublicPaneState;
}
