import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export type ActivationMode = 'attach' | 'start';
export type PersistencePolicy = 'detach' | 'kill';
export type ConfigStorageStatus = 'created' | 'error' | 'loaded' | 'migrated' | 'recovered';
export type StateStorageStatus = ConfigStorageStatus;
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

export type RuntimeCwdState = 'current' | 'deleted' | 'unavailable';

export interface RuntimeCwd {
  path: string | null;
  state: RuntimeCwdState;
  stale: boolean;
}

export type RuntimeGitState = 'pending' | 'repository' | 'not_repository' | 'unavailable';

export interface RuntimeGit {
  state: RuntimeGitState;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  stale: boolean;
}

export interface NormalizedSessionSummary {
  sessionId: string;
  command: string | null;
  cwd: string | null;
  runtimeCwd: RuntimeCwd | null;
  runtimeCwdComplete: boolean;
  runtimeGit: RuntimeGit | null;
  runtimeGitComplete: boolean;
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

export interface TerminalTheme {
  name: string;
  background: string;
  foreground: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  theme: TerminalTheme;
}

export interface LaunchProfile {
  type?: 'process';
  command: string;
  args: string[];
  cwd: string | null;
}

export interface DesktopLaunchProfile extends LaunchProfile {
  type: 'process';
}

export interface DesktopSessionConfig {
  id: string;
  title: string;
  launchProfile: string;
}

export interface DesktopWorkspaceConfig {
  id: string;
  name: string;
  layout: { columns: number };
  sessions: DesktopSessionConfig[];
}

export interface DesktopConfig {
  schemaVersion: number;
  hub: { endpoint: string };
  sessionPrefix: string;
  persistence: { onWindowClose: PersistencePolicy };
  terminal: TerminalAppearance;
  launchProfiles: Record<string, DesktopLaunchProfile>;
  workspaces: DesktopWorkspaceConfig[];
}

export interface DesktopState {
  schemaVersion: number;
  window: {
    width: number;
    height: number;
  };
  activeWorkspaceId: string | null;
}

export interface DesktopDiagnostics {
  configStatus: ConfigStorageStatus;
  stateStatus: StateStorageStatus;
  warnings: string[];
  errors: string[];
}

export interface DesktopBootstrapResult {
  config: DesktopConfig | null;
  state: DesktopState;
  diagnostics: DesktopDiagnostics;
}

export interface RendererBootstrapSession {
  id: string;
  title: string;
  launchProfile: DesktopLaunchProfile;
}

export interface RendererBootstrapWorkspace {
  id: string;
  name: string;
  layout: { columns: number };
  sessions: RendererBootstrapSession[];
}

export interface RendererBootstrapConfig {
  schemaVersion: number;
  configurationValid: boolean;
  endpoint: string;
  capabilityToken: string;
  sessionPrefix: string;
  persistencePolicy: PersistencePolicy;
  terminal: TerminalAppearance | null;
  activeWorkspaceId: string | null;
  workspaces: RendererBootstrapWorkspace[];
  diagnostics: DesktopDiagnostics;
  testMode: boolean;
}

export interface PaneDescriptor {
  index: number;
  workspaceId: string;
  paneId: string;
  sessionKey: string;
  title: string;
  terminalElementId: string;
  sessionId: string;
  launchProfile: LaunchProfile;
}

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  layout: { columns: number };
  panes: PaneDescriptor[];
}

export interface AppDiagnostics {
  configStatus: string;
  stateStatus: string;
  warnings: string[];
  errors: string[];
}

export interface RendererAppConfig {
  schemaVersion: unknown;
  configurationValid: boolean;
  endpoint: string;
  capabilityToken: string;
  sessionPrefix: string;
  persistencePolicy: PersistencePolicy;
  terminal: TerminalAppearance | null;
  testMode: boolean;
  activeWorkspaceId: string | null;
  diagnostics: AppDiagnostics;
  workspaces: WorkspaceDescriptor[];
}

export type WorkspaceSummaryState =
  | 'attention'
  | 'available'
  | 'connecting'
  | 'detached'
  | 'error'
  | 'idle'
  | 'in_use'
  | 'reconnecting'
  | 'running'
  | 'stopped';

export interface WorkspaceSummary {
  id: string;
  location: string;
  locationSource: 'config' | 'hub' | 'mixed' | 'runtime';
  git: string | null;
  state: WorkspaceSummaryState;
  label: string;
  detail: string;
}

export interface PublicConfiguration {
  valid: boolean;
  configStatus: string;
  stateStatus: string;
  warnings: string[];
  errors: string[];
  persistencePolicy: string;
  sessions?: unknown[];
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
    summaries: WorkspaceSummary[];
  };
  sessionDiscovery: {
    status: string;
    sessionListEvents: number;
    sessions: string[];
    sessionSummaries: NormalizedSessionSummary[];
    error: string;
  };
}

export interface RendererTestApi {
  getState(): RendererPublicState;
  sendText(paneId: string, text: string): void;
  pasteText(paneId: string, text: string): void;
  killPane(paneId: string): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<void>;
  acknowledgeWorkspaceAttention(workspaceId: string): Promise<void>;
  disconnectPaneSocket(paneId: string): void;
  selectAll(paneId: string): void;
  simulatePasteShortcutRace(paneId: string, text: string): void;
}

export type PrepareCloseCallback = () => void | Promise<void>;

export interface NeoncodeDesktopApi {
  readonly config: unknown;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  setActiveWorkspace(workspaceId: string): Promise<string>;
  onPrepareClose(callback: PrepareCloseCallback): void;
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
