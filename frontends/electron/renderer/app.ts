import type {
  ExitSummary,
  LaunchProfile,
  NormalizedSessionSummary,
  PaneDescriptor,
  PersistencePolicy,
  RendererAppConfig,
  SessionLifecycle,
  TerminalAppearance,
  WorkspaceDescriptor,
  WorkspaceSummary,
  WorkspaceSummaryState,
} from '../shared/types';
import { HubClient, type UnknownMessage } from './hub-client';
import { SessionModel } from './session-model';
import { TerminalPane } from './terminal-pane';
import { installRendererTestApi } from './test-api';

export const STARTUP_SESSION_LIST_TIMEOUT_MS = 2000;
export const CONTROL_OPERATION_TIMEOUT_MS = 1500;

type TimerHandle = ReturnType<typeof setTimeout>;
type WorkspaceSessionLifecycle = SessionLifecycle | 'available' | 'idle' | 'in_use';

interface WorkspaceAttention extends ExitSummary {
  sessionId: string;
  title: string;
}

interface WorkspaceSessionState {
  workspaceId: string;
  lifecycle: WorkspaceSessionLifecycle;
  error: string;
  attention: WorkspaceAttention | null;
}

interface WorkspaceLocation {
  label: string;
  source: 'config' | 'hub' | 'mixed' | 'runtime';
}

interface WorkspaceAggregate {
  state: WorkspaceSummaryState;
  label: string;
  detail: string;
}

interface NeonCodeAppOptions {
  documentRef?: Document;
  windowRef?: Window;
  bootstrap?: unknown;
}

interface WorkspaceSwitchOptions {
  initial?: boolean;
}

interface AttentionTarget {
  pane: PaneDescriptor;
  attentionId: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : [];
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`Invalid renderer bootstrap ${label}`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid renderer bootstrap ${label}`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid renderer bootstrap ${label}`);
  }
  return value;
}

function parseLaunchProfile(value: unknown): LaunchProfile {
  const profile = requiredRecord(value, 'launch profile');
  const args = profile.args;
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
    throw new Error('Invalid renderer bootstrap launch profile args');
  }
  const cwd = profile.cwd;
  if (cwd !== null && typeof cwd !== 'string') {
    throw new Error('Invalid renderer bootstrap launch profile cwd');
  }
  const parsed = {
    command: requiredString(profile.command, 'launch profile command'),
    args: [...args],
    cwd,
  };
  return profile.type === 'process' ? { type: 'process', ...parsed } : parsed;
}

function parseTerminalAppearance(value: unknown): TerminalAppearance {
  const appearance = requiredRecord(value, 'terminal appearance');
  const theme = requiredRecord(appearance.theme, 'terminal theme');
  if (typeof appearance.cursorBlink !== 'boolean') {
    throw new Error('Invalid renderer bootstrap terminal cursorBlink');
  }
  return {
    fontFamily: requiredString(appearance.fontFamily, 'terminal fontFamily'),
    fontSize: requiredNumber(appearance.fontSize, 'terminal fontSize'),
    cursorBlink: appearance.cursorBlink,
    theme: {
      name: requiredString(theme.name, 'terminal theme name'),
      background: requiredString(theme.background, 'terminal theme background'),
      foreground: requiredString(theme.foreground, 'terminal theme foreground'),
      cursorColor: requiredString(theme.cursorColor, 'terminal theme cursorColor'),
      selectionBackground: requiredString(theme.selectionBackground, 'terminal theme selectionBackground'),
      black: requiredString(theme.black, 'terminal theme black'),
      red: requiredString(theme.red, 'terminal theme red'),
      green: requiredString(theme.green, 'terminal theme green'),
      yellow: requiredString(theme.yellow, 'terminal theme yellow'),
      blue: requiredString(theme.blue, 'terminal theme blue'),
      purple: requiredString(theme.purple, 'terminal theme purple'),
      cyan: requiredString(theme.cyan, 'terminal theme cyan'),
      white: requiredString(theme.white, 'terminal theme white'),
      brightBlack: requiredString(theme.brightBlack, 'terminal theme brightBlack'),
      brightRed: requiredString(theme.brightRed, 'terminal theme brightRed'),
      brightGreen: requiredString(theme.brightGreen, 'terminal theme brightGreen'),
      brightYellow: requiredString(theme.brightYellow, 'terminal theme brightYellow'),
      brightBlue: requiredString(theme.brightBlue, 'terminal theme brightBlue'),
      brightPurple: requiredString(theme.brightPurple, 'terminal theme brightPurple'),
      brightCyan: requiredString(theme.brightCyan, 'terminal theme brightCyan'),
      brightWhite: requiredString(theme.brightWhite, 'terminal theme brightWhite'),
    },
  };
}

function isExitSummary(value: unknown): value is NormalizedSessionSummary['latestExit'] {
  if (value === null) return true;
  return isRecord(value)
    && typeof value.attentionId === 'string'
    && (value.status === null || (typeof value.status === 'number' && Number.isInteger(value.status)))
    && (value.reason === 'process_exit' || value.reason === 'wait_failed' || value.reason === 'killed');
}

function isNormalizedSessionSummary(value: unknown): value is NormalizedSessionSummary {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === 'string'
    && (value.command === null || typeof value.command === 'string')
    && (value.cwd === null || typeof value.cwd === 'string')
    && typeof value.runtimeCwdComplete === 'boolean'
    && (value.runtimeCwd === null || isRecord(value.runtimeCwd))
    && typeof value.runtimeGitComplete === 'boolean'
    && (value.runtimeGit === null || isRecord(value.runtimeGit))
    && (value.persistent === null || typeof value.persistent === 'boolean')
    && (value.attachmentCount === null
      || (typeof value.attachmentCount === 'number' && Number.isInteger(value.attachmentCount)))
    && typeof value.metadataComplete === 'boolean'
    && (value.state === 'running' || value.state === 'exited')
    && isExitSummary(value.latestExit)
    && typeof value.lifecycleComplete === 'boolean'
    && (value.instanceId === null || typeof value.instanceId === 'string')
    && typeof value.instanceComplete === 'boolean';
}

function requiredElement(documentRef: Document, id: string): HTMLElement {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing renderer element: #${id}`);
  return element;
}

export function createSessionId(sessionPrefix: string, sessionKey: string): string {
  return `${sessionPrefix}-${sessionKey}`;
}

export function createWorkspaceDescriptors(bootstrap: unknown): WorkspaceDescriptor[] {
  const source = isRecord(bootstrap) ? bootstrap : {};
  const workspaces = source.workspaces;
  if (workspaces === undefined || workspaces === null) return [];
  if (!Array.isArray(workspaces)) throw new Error('Invalid renderer bootstrap workspaces');
  const sessionPrefix = stringOr(source.sessionPrefix, '');
  return workspaces.map((rawWorkspace) => {
    const workspace = requiredRecord(rawWorkspace, 'workspace');
    const id = requiredString(workspace.id, 'workspace id');
    const layout = requiredRecord(workspace.layout, 'workspace layout');
    const sessions = workspace.sessions;
    if (!Array.isArray(sessions)) throw new Error('Invalid renderer bootstrap workspace sessions');
    return {
      id,
      name: requiredString(workspace.name, 'workspace name'),
      layout: { columns: requiredNumber(layout.columns, 'workspace columns') },
      panes: sessions.map((rawSession, index) => {
        const session = requiredRecord(rawSession, 'session');
        const sessionKey = requiredString(session.id, 'session id');
        return {
          index,
          workspaceId: id,
          paneId: sessionKey,
          sessionKey,
          title: requiredString(session.title, 'session title'),
          terminalElementId: `terminal-${id}-${sessionKey}`,
          sessionId: createSessionId(sessionPrefix, sessionKey),
          launchProfile: parseLaunchProfile(session.launchProfile),
        };
      }),
    };
  });
}

export function createAppConfig(bootstrap: unknown = {}): RendererAppConfig {
  const source = isRecord(bootstrap) ? bootstrap : {};
  const diagnostics = isRecord(source.diagnostics) ? source.diagnostics : {};
  const persistencePolicy: PersistencePolicy = source.persistencePolicy === 'kill' ? 'kill' : 'detach';
  return {
    schemaVersion: source.schemaVersion,
    configurationValid: source.configurationValid === true,
    endpoint: stringOr(source.endpoint, ''),
    capabilityToken: stringOr(source.capabilityToken, ''),
    sessionPrefix: stringOr(source.sessionPrefix, ''),
    persistencePolicy,
    terminal: source.terminal ? parseTerminalAppearance(source.terminal) : null,
    testMode: source.testMode === true,
    activeWorkspaceId: typeof source.activeWorkspaceId === 'string' && source.activeWorkspaceId
      ? source.activeWorkspaceId
      : null,
    diagnostics: {
      configStatus: stringOr(diagnostics.configStatus, 'error'),
      stateStatus: stringOr(diagnostics.stateStatus, 'error'),
      warnings: stringArrayOrEmpty(diagnostics.warnings),
      errors: stringArrayOrEmpty(diagnostics.errors),
    },
    workspaces: createWorkspaceDescriptors(source),
  };
}

export class NeonCodeApp {
  readonly document: Document;
  readonly window: Window;
  readonly config: RendererAppConfig;
  readonly statusElement: HTMLElement;
  readonly configurationStatusElement: HTMLElement;
  readonly workspaceList: HTMLElement;
  readonly terminalGrid: HTMLElement;
  readonly sessionModel: SessionModel;
  sessionDiscoveryClient: HubClient | undefined;
  metadataRefreshTimer: ReturnType<typeof setInterval> | undefined;
  metadataRefreshPending = false;
  discoveredSessionIds = new Set<string>();
  hubSessionsById = new Map<string, NormalizedSessionSummary>();
  readonly visitedSessionIds = new Set<string>();
  readonly workspaceSessionStates: Map<string, WorkspaceSessionState>;
  panes: TerminalPane[] = [];
  activeWorkspaceId: string | null = null;
  closed = false;
  closePromise: Promise<void> | undefined;
  switchPromise: Promise<void> = Promise.resolve();
  switching = false;

  constructor({ documentRef = document, windowRef = window, bootstrap = {} }: NeonCodeAppOptions = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(bootstrap);
    this.statusElement = requiredElement(this.document, 'status');
    this.configurationStatusElement = requiredElement(this.document, 'configuration-status');
    this.workspaceList = requiredElement(this.document, 'workspace-list');
    this.terminalGrid = requiredElement(this.document, 'terminal-grid');
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.sessionModel.setConfiguration({
      valid: this.config.configurationValid,
      configStatus: this.config.diagnostics.configStatus,
      stateStatus: this.config.diagnostics.stateStatus,
      warnings: this.config.diagnostics.warnings,
      errors: this.config.diagnostics.errors,
      persistencePolicy: this.config.persistencePolicy,
      terminal: this.config.terminal,
      activeWorkspaceId: this.config.activeWorkspaceId,
      workspaces: this.config.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        layout: workspace.layout,
        sessions: workspace.panes.map(({ paneId, title, sessionId, launchProfile }) => ({
          id: paneId,
          title,
          sessionId,
          launchProfile,
        })),
      })),
    });
    this.workspaceSessionStates = new Map(
      this.config.workspaces.flatMap((workspace) => workspace.panes.map((pane) => [
        pane.sessionId,
        {
          workspaceId: workspace.id,
          lifecycle: 'idle' as const,
          error: '',
          attention: null,
        },
      ])),
    );
    if (this.config.testMode) installRendererTestApi(this);
  }

  setStatus(text: string): void {
    this.statusElement.textContent = text;
  }

  addRuntimeWarning(warning: string): void {
    if (!this.config.diagnostics.warnings.includes(warning)) {
      this.config.diagnostics.warnings.push(warning);
    }
    this.sessionModel.addConfigurationWarning(warning);
    this.showConfigurationDiagnostics();
  }

  showConfigurationDiagnostics(): void {
    const { warnings, errors } = this.config.diagnostics;
    if (errors.length > 0) {
      this.configurationStatusElement.textContent = `Configuration error: ${errors.join('; ')}`;
      this.configurationStatusElement.dataset.state = 'error';
    } else if (warnings.length > 0) {
      this.configurationStatusElement.textContent = warnings.join('; ');
      this.configurationStatusElement.dataset.state = 'warning';
    } else {
      this.configurationStatusElement.textContent = '';
      this.configurationStatusElement.dataset.state = 'ready';
    }
  }

  workspaceLocation(workspace: WorkspaceDescriptor): WorkspaceLocation {
    let hubMetadataCount = 0;
    let runtimeMetadataCount = 0;
    const paths = new Set(workspace.panes.map((pane) => {
      const hubSession = this.hubSessionsById.get(pane.sessionId);
      if (hubSession?.runtimeCwdComplete && hubSession.runtimeCwd?.path) {
        runtimeMetadataCount += 1;
        return hubSession.runtimeCwd.state === 'deleted'
          ? `${hubSession.runtimeCwd.path} (deleted)`
          : hubSession.runtimeCwd.path;
      }
      if (hubSession?.metadataComplete) {
        hubMetadataCount += 1;
        return hubSession.cwd || 'default cwd';
      }
      return pane.launchProfile.cwd || 'default cwd';
    }));
    const location = paths.size === 1 ? paths.values().next().value ?? 'default cwd' : `${paths.size} paths`;
    const source = runtimeMetadataCount === workspace.panes.length
      ? 'runtime'
      : runtimeMetadataCount > 0
        ? 'mixed'
        : hubMetadataCount === workspace.panes.length
          ? 'hub'
          : hubMetadataCount > 0 ? 'mixed' : 'config';
    return { label: `WSL · ${location}`, source };
  }

  workspaceGit(workspace: WorkspaceDescriptor): string | null {
    const repositories = workspace.panes
      .map((pane) => this.hubSessionsById.get(pane.sessionId)?.runtimeGit)
      .filter((git) => git?.state === 'repository');
    if (repositories.length === 0) return null;
    const identities = new Set(repositories.map((git) => git?.detached ? 'detached' : git?.branch ?? 'unknown'));
    const dirty = repositories.some((git) => git?.dirty);
    const identity = identities.size === 1
      ? identities.values().next().value ?? 'unknown'
      : `${identities.size} branches`;
    return `Git · ${identity}${dirty ? ' *' : ''}`;
  }

  workspaceSummary(workspace: WorkspaceDescriptor): WorkspaceAggregate {
    const states = workspace.panes.map((pane) => (
      this.workspaceSessionStates.get(pane.sessionId)
        ?? { workspaceId: workspace.id, lifecycle: 'idle' as const, error: '', attention: null }
    ));
    const count = (lifecycles: WorkspaceSessionLifecycle[]): number => (
      states.filter((state) => lifecycles.includes(state.lifecycle)).length
    );
    const firstAttention = states.find((state) => state.attention)?.attention;
    if (firstAttention) {
      const attentionCount = states.filter((state) => state.attention).length;
      const status = firstAttention.status === null ? 'unknown status' : `status ${firstAttention.status}`;
      return {
        state: 'attention',
        label: attentionCount === 1 ? 'Needs attention' : `${attentionCount} need attention`,
        detail: `${firstAttention.title} exited with ${status} (${firstAttention.reason.replaceAll('_', ' ')})`,
      };
    }
    const errors = states.filter((state) => state.error).map((state) => state.error);
    if (errors.length > 0 || count(['error']) > 0) {
      return { state: 'error', label: 'Error', detail: errors[0] ?? 'Session error' };
    }
    if (count(['reconnecting']) > 0) {
      return { state: 'reconnecting', label: 'Reconnecting', detail: 'Session reconnecting' };
    }
    const stopped = count(['killed', 'exited']);
    if (stopped > 0) {
      return { state: 'stopped', label: `${stopped} stopped`, detail: `${stopped} sessions stopped` };
    }
    const running = count(['started', 'attached']);
    if (running > 0) {
      return { state: 'running', label: `${running} running`, detail: `${running} of ${states.length} sessions running` };
    }
    if (count(['connecting', 'starting', 'attaching', 'detaching', 'killing']) > 0) {
      return { state: 'connecting', label: 'Connecting', detail: 'Session transition in progress' };
    }
    const detached = count(['detached']);
    if (detached > 0) {
      return { state: 'detached', label: `${detached} detached`, detail: `${detached} sessions detached` };
    }
    const inUse = count(['in_use']);
    if (inUse > 0) {
      return { state: 'in_use', label: `${inUse} in use`, detail: `${inUse} sessions attached elsewhere` };
    }
    const available = count(['available']);
    if (available > 0) {
      return { state: 'available', label: `${available} available`, detail: `${available} hub sessions available` };
    }
    return { state: 'idle', label: 'Not started', detail: 'No workspace sessions started' };
  }

  updateWorkspaceStatuses(): void {
    const summaries: WorkspaceSummary[] = this.config.workspaces.map((workspace) => {
      const location = this.workspaceLocation(workspace);
      return {
        id: workspace.id,
        location: location.label,
        locationSource: location.source,
        git: this.workspaceGit(workspace),
        ...this.workspaceSummary(workspace),
      };
    });
    this.sessionModel.setWorkspaceSummaries(summaries);
    for (const summary of summaries) {
      const entry = this.workspaceList.querySelector<HTMLElement>(
        `.workspace-entry[data-workspace-id="${summary.id}"]`,
      );
      const button = entry?.querySelector<HTMLButtonElement>('.workspace-button');
      const status = entry?.querySelector<HTMLElement>('.workspace-status');
      const location = entry?.querySelector<HTMLElement>('.workspace-location');
      const git = entry?.querySelector<HTMLElement>('.workspace-git');
      const acknowledge = entry?.querySelector<HTMLButtonElement>('.workspace-attention-button');
      if (!button || !status || !location || !git || !acknowledge) continue;
      button.dataset.state = summary.state;
      button.title = `${summary.location} — ${summary.detail}`;
      location.textContent = summary.location;
      location.dataset.source = summary.locationSource;
      git.textContent = summary.git ?? '';
      git.hidden = summary.git === null;
      status.dataset.state = summary.state;
      status.textContent = summary.label;
      acknowledge.hidden = summary.state !== 'attention';
    }
  }

  updateHubSessionMetadata(descriptor: PaneDescriptor, lifecycle: SessionLifecycle): void {
    const existing = this.hubSessionsById.get(descriptor.sessionId);
    if (lifecycle === 'started') {
      this.hubSessionsById.set(descriptor.sessionId, {
        sessionId: descriptor.sessionId,
        command: descriptor.launchProfile.command,
        cwd: descriptor.launchProfile.cwd,
        runtimeCwd: existing?.runtimeCwd ?? null,
        runtimeCwdComplete: existing?.runtimeCwdComplete ?? false,
        runtimeGit: existing?.runtimeGit ?? null,
        runtimeGitComplete: existing?.runtimeGitComplete ?? false,
        persistent: true,
        attachmentCount: 1,
        metadataComplete: true,
        state: 'running',
        latestExit: existing?.latestExit ?? null,
        lifecycleComplete: true,
        instanceId: existing?.instanceId ?? null,
        instanceComplete: existing?.instanceComplete ?? false,
      });
      this.discoveredSessionIds.add(descriptor.sessionId);
    } else if (lifecycle === 'detached' && existing?.metadataComplete) {
      this.hubSessionsById.set(descriptor.sessionId, { ...existing, attachmentCount: 0 });
    } else if (lifecycle === 'killed') {
      if (existing?.latestExit) {
        this.hubSessionsById.set(descriptor.sessionId, { ...existing, attachmentCount: 0, state: 'exited' });
      } else {
        this.hubSessionsById.delete(descriptor.sessionId);
      }
      this.discoveredSessionIds.delete(descriptor.sessionId);
    }
  }

  recordSessionExit(descriptor: PaneDescriptor, outcome: ExitSummary): void {
    const latestExit = {
      attentionId: outcome.attentionId,
      status: outcome.status,
      reason: outcome.reason,
    };
    const existing = this.hubSessionsById.get(descriptor.sessionId);
    this.hubSessionsById.set(descriptor.sessionId, {
      sessionId: descriptor.sessionId,
      command: existing?.command || descriptor.launchProfile.command,
      cwd: existing ? existing.cwd : descriptor.launchProfile.cwd,
      runtimeCwd: existing?.runtimeCwd ?? null,
      runtimeCwdComplete: existing?.runtimeCwdComplete ?? false,
      runtimeGit: existing?.runtimeGit ?? null,
      runtimeGitComplete: existing?.runtimeGitComplete ?? false,
      persistent: existing?.persistent ?? true,
      attachmentCount: 0,
      metadataComplete: true,
      state: 'exited',
      latestExit: outcome.attentionId ? { ...latestExit, attentionId: outcome.attentionId } : null,
      lifecycleComplete: true,
      instanceId: existing?.instanceId ?? null,
      instanceComplete: existing?.instanceComplete ?? false,
    });
    this.discoveredSessionIds.delete(descriptor.sessionId);
    const current = this.workspaceSessionStates.get(descriptor.sessionId);
    if (current) {
      this.workspaceSessionStates.set(descriptor.sessionId, {
        ...current,
        attention: {
          ...latestExit,
          sessionId: descriptor.sessionId,
          title: descriptor.title,
        },
      });
      this.updateWorkspaceStatuses();
    }
  }

  recordWorkspaceSessionState(sessionId: string, lifecycle: SessionLifecycle, error = ''): void {
    const current = this.workspaceSessionStates.get(sessionId);
    if (!current) return;
    this.workspaceSessionStates.set(sessionId, { ...current, lifecycle, error });
    this.updateWorkspaceStatuses();
  }

  renderWorkspaceSelector(): void {
    this.workspaceList.replaceChildren();
    for (const workspace of this.config.workspaces) {
      const entry = this.document.createElement('div');
      entry.className = 'workspace-entry';
      entry.dataset.workspaceId = workspace.id;
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-button';
      button.dataset.workspaceId = workspace.id;
      button.dataset.testid = `workspace-${workspace.id}`;
      button.setAttribute('aria-current', workspace.id === this.activeWorkspaceId ? 'true' : 'false');
      button.disabled = this.switching;

      const identity = this.document.createElement('span');
      identity.className = 'workspace-identity';
      const name = this.document.createElement('span');
      name.className = 'workspace-name';
      name.textContent = workspace.name;
      const location = this.document.createElement('span');
      location.className = 'workspace-location';
      location.textContent = this.workspaceLocation(workspace).label;
      identity.append(name, location);
      const git = this.document.createElement('span');
      git.className = 'workspace-git';
      git.hidden = true;
      identity.append(git);
      const status = this.document.createElement('span');
      status.className = 'workspace-status';
      status.dataset.testid = `workspace-status-${workspace.id}`;
      button.append(identity, status);
      button.addEventListener('click', () => {
        this.switchWorkspace(workspace.id).catch((error) => {
          console.error('workspace_switch_failed', error);
          this.setStatus(`Workspace switch failed: ${errorMessage(error)}`);
        });
      });
      const acknowledge = this.document.createElement('button');
      acknowledge.type = 'button';
      acknowledge.className = 'workspace-attention-button';
      acknowledge.dataset.testid = `workspace-acknowledge-${workspace.id}`;
      acknowledge.textContent = 'Dismiss';
      acknowledge.setAttribute('aria-label', `Dismiss exit attention for ${workspace.name}`);
      acknowledge.title = `Dismiss exit attention for ${workspace.name}`;
      acknowledge.hidden = true;
      acknowledge.addEventListener('click', () => {
        acknowledge.disabled = true;
        this.acknowledgeWorkspaceAttention(workspace.id)
          .catch((error) => {
            console.error('workspace_attention_acknowledge_failed', error);
            this.setStatus(`Could not dismiss workspace attention: ${errorMessage(error)}`);
          })
          .finally(() => {
            acknowledge.disabled = false;
          });
      });
      entry.append(button, acknowledge);
      this.workspaceList.append(entry);
    }
    this.updateWorkspaceStatuses();
  }

  updateWorkspaceSelector(): void {
    for (const button of this.workspaceList.querySelectorAll<HTMLButtonElement>('.workspace-button')) {
      button.setAttribute('aria-current', button.dataset.workspaceId === this.activeWorkspaceId ? 'true' : 'false');
      button.disabled = this.switching;
    }
  }

  async start(): Promise<void> {
    this.showConfigurationDiagnostics();
    if (!this.config.configurationValid) {
      const message = this.config.diagnostics.errors.join('; ') || 'Configuration is invalid';
      this.sessionModel.setSessionDiscoveryStatus('configuration_error', message);
      this.setStatus('Configuration error — edit %APPDATA%\\NeonCode\\config.json and restart');
      return;
    }

    this.renderWorkspaceSelector();
    const discoveredSessions = await this.discoverSessions();
    this.discoveredSessionIds = new Set(
      discoveredSessions.filter((session) => session.state === 'running').map((session) => session.sessionId),
    );
    this.hubSessionsById = new Map(discoveredSessions.map((session) => [session.sessionId, session]));
    for (const session of discoveredSessions) {
      const current = this.workspaceSessionStates.get(session.sessionId);
      if (current) {
        const lifecycle: WorkspaceSessionLifecycle = session.state === 'exited'
          ? 'idle'
          : session.metadataComplete && session.attachmentCount !== null && session.attachmentCount > 0
            ? 'in_use'
            : 'available';
        const pane = this.config.workspaces
          .flatMap((workspace) => workspace.panes)
          .find((candidate) => candidate.sessionId === session.sessionId);
        const attention: WorkspaceAttention | null = session.latestExit
          ? { ...session.latestExit, sessionId: session.sessionId, title: pane?.title || session.sessionId }
          : null;
        this.workspaceSessionStates.set(session.sessionId, { ...current, lifecycle, error: '', attention });
      }
    }
    this.updateWorkspaceStatuses();
    if (this.closed) return;
    const initialWorkspace = this.config.workspaces.find(
      (workspace) => workspace.id === this.config.activeWorkspaceId,
    ) ?? this.config.workspaces[0];
    if (!initialWorkspace) throw new Error('No configured workspace');
    await this.switchWorkspace(initialWorkspace.id, { initial: true });
    this.startMetadataRefresh();
  }

  startMetadataRefresh(): void {
    if (this.metadataRefreshTimer !== undefined) return;
    this.metadataRefreshTimer = setInterval(() => {
      if (this.closed || this.metadataRefreshPending) return;
      this.metadataRefreshPending = true;
      void this.discoverSessions()
        .then((sessions) => {
          if (this.closed || sessions.length === 0) return;
          this.discoveredSessionIds = new Set(
            sessions.filter((session) => session.state === 'running').map((session) => session.sessionId),
          );
          this.hubSessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
          for (const session of sessions) {
            const current = this.workspaceSessionStates.get(session.sessionId);
            if (!current) continue;
            const pane = this.config.workspaces
              .flatMap((workspace) => workspace.panes)
              .find((candidate) => candidate.sessionId === session.sessionId);
            const attention: WorkspaceAttention | null = session.latestExit
              ? { ...session.latestExit, sessionId: session.sessionId, title: pane?.title || session.sessionId }
              : null;
            this.workspaceSessionStates.set(session.sessionId, { ...current, attention });
          }
          this.updateWorkspaceStatuses();
          this.renderWorkspaceSelector();
        })
        .finally(() => {
          this.metadataRefreshPending = false;
        });
    }, 2500);
  }

  discoverSessions(): Promise<NormalizedSessionSummary[]> {
    this.sessionModel.setSessionDiscoveryStatus('connecting');

    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle!: TimerHandle;
      const finish = (sessions: NormalizedSessionSummary[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.sessionDiscoveryClient?.close();
        resolve(sessions);
      };

      timeoutHandle = setTimeout(() => {
        console.log('hub_session_list_timeout');
        this.sessionModel.setSessionDiscoveryStatus('timeout', 'Timed out waiting for session_list');
        finish([]);
      }, STARTUP_SESSION_LIST_TIMEOUT_MS);

      this.sessionDiscoveryClient = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        onOpen: () => {
          console.log('hub_session_list_requested');
          this.sessionModel.setSessionDiscoveryStatus('requested');
          this.sessionDiscoveryClient?.listSessions();
        },
        onMessage: (message: UnknownMessage) => {
          if (message.type === 'session_list') {
            if (!Array.isArray(message.sessions) || !message.sessions.every(isNormalizedSessionSummary)) {
              const error = 'Hub session discovery returned invalid normalized sessions';
              this.sessionModel.setSessionDiscoveryStatus('error', error);
              finish([]);
              return;
            }
            const sessions = message.sessions;
            console.log(`hub_session_list ${sessions.length} ${sessions.map((session) => session.sessionId).join(',')}`);
            this.sessionModel.recordSessionList(sessions);
            finish(sessions);
          } else if (message.type === 'error') {
            const error = typeof message.message === 'string' && message.message
              ? message.message
              : 'Hub session discovery error';
            console.log(`hub_session_list_error ${error}`);
            this.sessionModel.setSessionDiscoveryStatus('error', error);
            finish([]);
          }
        },
        onInvalidMessage: (error) => {
          const message = errorMessage(error);
          console.log(`hub_session_list_invalid_json ${message}`);
          this.sessionModel.setSessionDiscoveryStatus('error', message);
          finish([]);
        },
        onClose: () => {
          if (!settled) {
            console.log('hub_session_list_closed');
            this.sessionModel.setSessionDiscoveryStatus('closed', 'Session discovery WebSocket closed');
            finish([]);
          }
        },
        onError: () => {
          if (!settled) {
            console.log('hub_session_list_websocket_error');
            this.sessionModel.setSessionDiscoveryStatus('error', 'WebSocket error during session discovery');
            finish([]);
          }
        },
      });

      this.sessionDiscoveryClient.connect();
    });
  }

  switchWorkspace(workspaceId: string, { initial = false }: WorkspaceSwitchOptions = {}): Promise<void> {
    const operation = this.switchPromise.then(() => this.performWorkspaceSwitch(workspaceId, { initial }));
    this.switchPromise = operation.catch(() => {});
    return operation;
  }

  async performWorkspaceSwitch(
    workspaceId: string,
    { initial = false }: WorkspaceSwitchOptions = {},
  ): Promise<void> {
    if (this.closed) throw new Error('application is closing');
    const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
    if (!initial && workspaceId === this.activeWorkspaceId) return;

    this.switching = true;
    this.updateWorkspaceSelector();
    this.setStatus(`Switching to ${workspace.name}...`);
    try {
      try {
        await this.window.neoncodeDesktop.setActiveWorkspace(workspaceId);
      } catch (error) {
        if (!initial) throw error;
        this.addRuntimeWarning(`Active workspace could not be persisted: ${errorMessage(error)}`);
      }
      if (this.panes.length > 0) {
        await Promise.all(this.panes.map((pane) => pane.detachAndClose()));
        for (const pane of this.panes) pane.dispose();
      }
      this.panes = [];
      if (this.closed) return;
      this.terminalGrid.replaceChildren();
      this.sessionModel.resetPanes(workspaceId);
      this.activeWorkspaceId = workspaceId;
      this.configureWorkspaceGrid(workspace);
      this.updateWorkspaceSelector();

      for (const descriptor of workspace.panes) {
        this.createPaneSurface(descriptor);
        this.createPane(descriptor);
        this.discoveredSessionIds.add(descriptor.sessionId);
        this.visitedSessionIds.add(descriptor.sessionId);
      }
      this.sessionModel.setActiveWorkspace(workspaceId);
      this.setStatus(`Workspace: ${workspace.name}`);
    } finally {
      this.switching = false;
      this.updateWorkspaceSelector();
    }
  }

  configureWorkspaceGrid(workspace: WorkspaceDescriptor): void {
    const rows = Math.ceil(workspace.panes.length / workspace.layout.columns);
    this.terminalGrid.style.gridTemplateColumns = `repeat(${workspace.layout.columns}, minmax(0, 1fr))`;
    this.terminalGrid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  }

  createPaneSurface(descriptor: PaneDescriptor): void {
    const pane = this.document.createElement('section');
    pane.className = 'terminal-pane';
    pane.dataset.testid = `terminal-pane-${descriptor.paneId}`;

    const titleBar = this.document.createElement('div');
    titleBar.className = 'pane-title';
    const title = this.document.createElement('span');
    title.textContent = descriptor.title;
    title.dataset.testid = `pane-title-${descriptor.paneId}`;
    const status = this.document.createElement('span');
    status.id = `pane-status-${descriptor.paneId}`;
    status.className = 'pane-status';
    status.dataset.state = 'connecting';
    status.dataset.testid = `pane-status-${descriptor.paneId}`;
    status.textContent = 'Connecting';
    titleBar.append(title, status);

    const terminal = this.document.createElement('div');
    terminal.id = descriptor.terminalElementId;
    terminal.className = 'terminal';
    terminal.dataset.testid = `terminal-${descriptor.paneId}`;
    pane.append(titleBar, terminal);
    this.terminalGrid.append(pane);
  }

  createPane(descriptor: PaneDescriptor): void {
    const container = this.document.getElementById(descriptor.terminalElementId);
    if (!container) return;
    if (!this.config.terminal) throw new Error('Terminal appearance is unavailable');

    const pane = new TerminalPane({
      index: descriptor.index,
      paneId: descriptor.paneId,
      sessionKey: descriptor.sessionKey,
      sessionId: descriptor.sessionId,
      activationMode: this.discoveredSessionIds.has(descriptor.sessionId) ? 'attach' : 'start',
      endpoint: this.config.endpoint,
      capabilityToken: this.config.capabilityToken,
      launchProfile: descriptor.launchProfile,
      terminalAppearance: this.config.terminal,
      container,
      statusElement: this.document.getElementById(`pane-status-${descriptor.paneId}`),
      sessionModel: this.sessionModel,
      setStatus: (text) => this.setStatus(text),
      onLifecycleChange: (lifecycle, error) => {
        this.updateHubSessionMetadata(descriptor, lifecycle);
        this.recordWorkspaceSessionState(descriptor.sessionId, lifecycle, error);
      },
      onSessionExit: (outcome) => this.recordSessionExit(descriptor, outcome),
    });
    this.panes.push(pane);
    pane.start();
  }

  acknowledgeSessionAttention(sessionId: string, attentionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle!: TimerHandle;
      let client!: HubClient;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        client.close();
        if (error) reject(error); else resolve();
      };
      timeoutHandle = setTimeout(
        () => finish(new Error('attention acknowledgement timed out')),
        CONTROL_OPERATION_TIMEOUT_MS,
      );
      client = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        sessionId,
        onOpen: () => {
          if (!client.acknowledgeAttention(attentionId)) {
            finish(new Error('failed to send acknowledgement'));
          }
        },
        onMessage: (message) => {
          if (message.type === 'attention_acknowledged'
              && message.session_id === sessionId
              && message.attention_id === attentionId) {
            finish();
          } else if (message.type === 'error'
              && (!message.session_id || message.session_id === sessionId)) {
            finish(new Error(
              typeof message.message === 'string' && message.message
                ? message.message
                : 'attention acknowledgement failed',
            ));
          }
        },
        onInvalidMessage: (error) => finish(
          error instanceof Error ? error : new Error(errorMessage(error)),
        ),
        onClose: () => finish(new Error('attention acknowledgement connection closed')),
        onError: () => {},
      });
      client.connect();
    });
  }

  async acknowledgeWorkspaceAttention(workspaceId: string): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
    const targets: AttentionTarget[] = [];
    for (const pane of workspace.panes) {
      const attentionId = this.workspaceSessionStates.get(pane.sessionId)?.attention?.attentionId;
      if (typeof attentionId === 'string') targets.push({ pane, attentionId });
    }
    const results = await Promise.allSettled(targets.map((target) => (
      this.acknowledgeSessionAttention(target.pane.sessionId, target.attentionId)
    )));
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = targets[index];
      if (!target) return;
      const { pane, attentionId: acknowledgedId } = target;
      const current = this.workspaceSessionStates.get(pane.sessionId);
      if (!current?.attention || current.attention.attentionId !== acknowledgedId) return;
      this.workspaceSessionStates.set(pane.sessionId, { ...current, attention: null });
      const metadata = this.hubSessionsById.get(pane.sessionId);
      if (metadata?.latestExit?.attentionId !== acknowledgedId) return;
      if (metadata.state === 'exited') {
        this.hubSessionsById.delete(pane.sessionId);
      } else {
        this.hubSessionsById.set(pane.sessionId, { ...metadata, latestExit: null });
      }
    });
    this.updateWorkspaceStatuses();
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) throw new Error(`${failed.length} attention acknowledgement(s) failed`);
  }

  killDetachedSession(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle!: TimerHandle;
      let client!: HubClient;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        client.close();
        resolve();
      };
      timeoutHandle = setTimeout(finish, CONTROL_OPERATION_TIMEOUT_MS);
      client = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        sessionId,
        onOpen: () => {
          if (!client.kill()) finish();
        },
        onMessage: (message) => {
          if ((message.type === 'killed' && message.session_id === sessionId)
              || (message.type === 'error' && (!message.session_id || message.session_id === sessionId))) {
            finish();
          }
        },
        onInvalidMessage: finish,
        onClose: finish,
        onError: () => {},
      });
      client.connect();
    });
  }

  stopMetadataRefresh(): void {
    if (this.metadataRefreshTimer !== undefined) clearInterval(this.metadataRefreshTimer);
    this.metadataRefreshTimer = undefined;
    this.sessionDiscoveryClient?.close();
  }

  prepareToClose(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.stopMetadataRefresh();
    this.closePromise = (async () => {
      await this.switchPromise;
      if (this.config.persistencePolicy === 'kill') {
        for (const pane of this.panes) pane.close();
        await Promise.all([...this.visitedSessionIds].map((sessionId) => this.killDetachedSession(sessionId)));
        for (const pane of this.panes) pane.dispose();
      } else {
        await Promise.all(this.panes.map((pane) => pane.detachAndClose()));
      }
    })();
    return this.closePromise;
  }

  close(): void {
    this.closed = true;
    this.stopMetadataRefresh();
    for (const pane of this.panes) pane.dispose();
  }
}

export function startRendererApp(options: NeonCodeAppOptions = {}): NeonCodeApp {
  const app = new NeonCodeApp(options);
  window.addEventListener('DOMContentLoaded', () => {
    app.start().catch((error) => {
      console.error('app_start_failed', error);
      app.setStatus('Failed to start NeonCode app');
    });
  });
  window.addEventListener('beforeunload', () => {
    app.close();
  });
  return app;
}
