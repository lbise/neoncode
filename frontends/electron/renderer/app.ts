import type {
  DesktopLaunchProfile,
  DesktopWorkspaceConfig,
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
import {
  getCommandMetadata,
  type CommandDisabledReason,
  type CommandDispatchResult,
  type CommandExecutionArguments,
  type CommandInvocation,
  type CommandMetadata,
  type CommandOperationResult,
  type PaneCloseCommandArgs,
  type PaneSplitCommandArgs,
  type PaneTargetCommandArgs,
  type SplitResizeCommandArgs,
  type TabCloseCommandArgs,
  type TabCreateCommandArgs,
  type TabMoveCommandArgs,
  type TabOpenCommandArgs,
  type TabRenameCommandArgs,
  type WorkspaceCreateCommandArgs,
  type WorkspaceDeleteCommandArgs,
  type WorkspaceRenameCommandArgs,
} from '../shared/command-catalog';
import {
  availableKeybindingOverrides,
  createConcreteCommandInvocations,
  createDefaultKeybindings,
  mergeKeybindings,
  validateKeybindingSettings,
  type Keybinding,
  type KeybindingOverride,
} from '../shared/keybindings';
import { CommandPalette, type PaletteCommandEntry } from './command-palette';
import { CommandRegistry } from './command-registry';
import { HubClient, type UnknownMessage } from './hub-client';
import { KeybindingRouter } from './keybinding-router';
import {
  MAX_WORKSPACE_PANES,
  MAX_WORKSPACE_TABS,
  activateTab,
  addTab,
  closePane as closeLayoutPane,
  closeTab,
  computeDirectionalResizeDelta,
  focusPane as focusLayoutPane,
  moveTab,
  orderedPaneLeaves,
  orderedSplitIds,
  reconcileWorkspaceLayout,
  renameTab,
  resizeSplit,
  splitPane as splitLayoutPane,
  validateWorkspaceLayoutState,
  type LayoutNode,
  type PaneLeaf,
  type PaneResizeDirection,
  type TabLayout,
  type WorkspaceLayoutState,
} from '../shared/layout-model';
import { PaneFocusModel } from './pane-focus-model';
import { PaneDialog } from './pane-dialog';
import { SessionModel } from './session-model';
import { SettingsView, type BindableCommandEntry } from './settings-view';
import { TerminalPane } from './terminal-pane';
import { TabDialog } from './tab-dialog';
import { installRendererTestApi } from './test-api';
import { WorkspaceDialog } from './workspace-dialog';

export const STARTUP_SESSION_LIST_TIMEOUT_MS = 2000;
export const CONTROL_OPERATION_TIMEOUT_MS = 1500;

type TimerHandle = ReturnType<typeof setTimeout>;
type WorkspaceSessionLifecycle = SessionLifecycle | 'available' | 'idle' | 'in_use';

interface WorkspaceAttention extends ExitSummary {
  sessionId: string;
  title: string;
  notificationId?: string;
  notificationMessage?: string;
  notificationLevel?: 'info' | 'warning' | 'error';
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
  force?: boolean;
}

interface AttentionTarget {
  pane: PaneDescriptor;
  kind: 'exit' | 'notification';
  id: string;
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

function parseLaunchProfiles(value: unknown): Record<string, DesktopLaunchProfile> {
  if (!isRecord(value)) throw new Error('Invalid renderer bootstrap launch profiles');
  return Object.fromEntries(Object.entries(value).map(([profileId, profile]) => {
    const parsed = parseLaunchProfile(profile);
    return [profileId, { ...parsed, type: 'process' as const, args: [...parsed.args] }];
  }));
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

function nodeHasLayoutId(node: LayoutNode, id: string): boolean {
  if (node.type === 'pane') return node.paneId === id;
  return node.splitId === id || nodeHasLayoutId(node.first, id) || nodeHasLayoutId(node.second, id);
}

function layoutHasId(layout: WorkspaceLayoutState, id: string): boolean {
  return layout.tabs.some((tab) => tab.tabId === id || nodeHasLayoutId(tab.root, id));
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
    && typeof value.notificationComplete === 'boolean'
    && (value.latestNotification === null || isRecord(value.latestNotification))
    && typeof value.lifecycleComplete === 'boolean'
    && (value.instanceId === null || typeof value.instanceId === 'string')
    && typeof value.instanceComplete === 'boolean';
}

function requiredElement<T extends HTMLElement = HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing renderer element: #${id}`);
  return element as T;
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
    const workspacePath = workspace.path;
    if (workspacePath !== null && typeof workspacePath !== 'string') {
      throw new Error('Invalid renderer bootstrap workspace path');
    }
    return {
      id,
      name: requiredString(workspace.name, 'workspace name'),
      path: workspacePath,
      defaultLaunchProfile: requiredString(
        workspace.defaultLaunchProfile,
        'workspace default launch profile',
      ),
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
          launchProfileId: requiredString(session.launchProfileId, 'session launch profile id'),
          launchProfile: parseLaunchProfile(session.launchProfile),
        };
      }),
    };
  });
}

function parseWorkspaceLayouts(value: unknown): Record<string, WorkspaceLayoutState> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('Invalid renderer bootstrap workspace layouts');
  return Object.fromEntries(Object.entries(value).map(([workspaceId, layout]) => (
    [workspaceId, validateWorkspaceLayoutState(layout)]
  )));
}

export function createAppConfig(bootstrap: unknown = {}): RendererAppConfig {
  const source = isRecord(bootstrap) ? bootstrap : {};
  const diagnostics = isRecord(source.diagnostics) ? source.diagnostics : {};
  const persistencePolicy: PersistencePolicy = source.persistencePolicy === 'kill' ? 'kill' : 'detach';
  const workspaces = createWorkspaceDescriptors(source);
  const allowedInvocations = createConcreteCommandInvocations(
    workspaces.map((workspace) => workspace.id),
    workspaces.flatMap((workspace) => workspace.panes.map((pane) => pane.paneId)),
  );
  const keybindingOverrides = validateKeybindingSettings(
    { overrides: source.keybindingOverrides ?? [] },
    createDefaultKeybindings(workspaces.map((workspace) => workspace.id)),
    allowedInvocations,
    { tolerateUnavailable: true },
  ).overrides;
  return {
    schemaVersion: source.schemaVersion,
    configurationValid: source.configurationValid === true,
    endpoint: stringOr(source.endpoint, ''),
    capabilityToken: stringOr(source.capabilityToken, ''),
    sessionPrefix: stringOr(source.sessionPrefix, ''),
    persistencePolicy,
    terminal: source.terminal ? parseTerminalAppearance(source.terminal) : null,
    keybindingOverrides,
    testMode: source.testMode === true,
    activeWorkspaceId: typeof source.activeWorkspaceId === 'string' && source.activeWorkspaceId
      ? source.activeWorkspaceId
      : null,
    workspaceLayouts: parseWorkspaceLayouts(source.workspaceLayouts),
    launchProfiles: parseLaunchProfiles(source.launchProfiles ?? {}),
    diagnostics: {
      configStatus: stringOr(diagnostics.configStatus, 'error'),
      stateStatus: stringOr(diagnostics.stateStatus, 'error'),
      warnings: stringArrayOrEmpty(diagnostics.warnings),
      errors: stringArrayOrEmpty(diagnostics.errors),
    },
    workspaces,
  };
}

export interface RuntimeWorkspaceLayouts {
  layouts: Map<string, WorkspaceLayoutState>;
  changedWorkspaceIds: Set<string>;
}

export function createRuntimeWorkspaceLayouts(config: RendererAppConfig): RuntimeWorkspaceLayouts {
  const layouts = new Map<string, WorkspaceLayoutState>();
  const changedWorkspaceIds = new Set<string>();
  for (const workspace of config.workspaces) {
    const result = reconcileWorkspaceLayout({
      name: workspace.name,
      layout: workspace.layout,
      sessions: workspace.panes.map((pane) => ({ id: pane.sessionKey, title: pane.title })),
    }, config.workspaceLayouts[workspace.id]);
    layouts.set(workspace.id, result.state);
    if (result.changed) changedWorkspaceIds.add(workspace.id);
  }
  return { layouts, changedWorkspaceIds };
}

export class NeonCodeApp {
  readonly document: Document;
  readonly window: Window;
  readonly config: RendererAppConfig;
  readonly statusElement: HTMLElement;
  readonly configurationStatusElement: HTMLElement;
  readonly workspaceList: HTMLElement;
  readonly workspaceTabs: HTMLElement;
  readonly terminalGrid: HTMLElement;
  readonly sessionModel: SessionModel;
  readonly focusModel: PaneFocusModel;
  readonly commandRegistry: CommandRegistry;
  keybindingRouter: KeybindingRouter;
  readonly commandPalette: CommandPalette;
  readonly settingsView: SettingsView;
  readonly workspaceDialog: WorkspaceDialog;
  readonly tabDialog: TabDialog;
  readonly paneDialog: PaneDialog;
  readonly workspaceLayouts: Map<string, WorkspaceLayoutState>;
  readonly pendingInitialLayoutSaves: Set<string>;
  readonly layoutSavePromises = new Map<string, Promise<void>>();
  readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (this.paneDialog.isOpen) {
      this.paneDialog.handleKeyDown(event);
      return;
    }
    if (this.tabDialog.isOpen) {
      this.tabDialog.handleKeyDown(event);
      return;
    }
    if (this.workspaceDialog.isOpen) {
      this.workspaceDialog.handleKeyDown(event);
      return;
    }
    if (this.settingsView.isOpen) {
      this.settingsView.handleKeyDown(event);
      return;
    }
    if (this.commandPalette.isOpen) {
      this.commandPalette.handleKeyDown(event);
      return;
    }
    const resolution = this.keybindingRouter.resolve({
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altGraphKey: event.getModifierState('AltGraph'),
      defaultPrevented: event.defaultPrevented,
      repeat: event.repeat,
    });
    if (!resolution.claimed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (resolution.execute) this.dispatchCommand(resolution.command);
  };
  sessionDiscoveryClient: HubClient | undefined;
  metadataRefreshTimer: ReturnType<typeof setInterval> | undefined;
  metadataRefreshPending = false;
  discoveredSessionIds = new Set<string>();
  hubSessionsById = new Map<string, NormalizedSessionSummary>();
  readonly visitedSessionIds = new Set<string>();
  readonly workspaceSessionStates: Map<string, WorkspaceSessionState>;
  panes: TerminalPane[] = [];
  closed = false;
  closePromise: Promise<void> | undefined;
  switchPromise: Promise<void> = Promise.resolve();
  switching = false;
  catalogSaving = false;
  paneOperationBusy = false;

  constructor({ documentRef = document, windowRef = window, bootstrap = {} }: NeonCodeAppOptions = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(bootstrap);
    this.statusElement = requiredElement(this.document, 'status');
    this.configurationStatusElement = requiredElement(this.document, 'configuration-status');
    this.workspaceList = requiredElement(this.document, 'workspace-list');
    this.workspaceTabs = requiredElement(this.document, 'workspace-tabs');
    this.terminalGrid = requiredElement(this.document, 'terminal-grid');
    const runtimeLayouts = createRuntimeWorkspaceLayouts(this.config);
    this.workspaceLayouts = runtimeLayouts.layouts;
    this.pendingInitialLayoutSaves = runtimeLayouts.changedWorkspaceIds;
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.focusModel = new PaneFocusModel(this.config.workspaces.map((workspace) => {
      const layout = this.workspaceLayouts.get(workspace.id);
      const activeTab = layout?.tabs.find((tab) => tab.tabId === layout.activeTabId);
      return {
        workspaceId: workspace.id,
        paneIds: activeTab ? orderedPaneLeaves(activeTab.root).map((pane) => pane.paneId) : [],
      };
    }));
    this.commandRegistry = new CommandRegistry({
      'palette.open': () => this.commandPalette.open(),
      'palette.close': () => this.commandPalette.close(),
      'settings.open': () => this.settingsView.open(),
      'settings.close': () => this.settingsView.close(),
      'workspace.create': (args) => this.createWorkspace(args),
      'workspace.rename': (args) => this.renameWorkspace(args),
      'workspace.delete': (args) => this.deleteWorkspace(args),
      'workspace.createDialog': () => this.workspaceDialog.open('create'),
      'workspace.renameDialog': () => this.workspaceDialog.open('rename'),
      'workspace.deleteDialog': () => this.workspaceDialog.open('delete'),
      'workspace.open': ({ workspaceId }) => this.switchWorkspace(workspaceId),
      'workspace.next': () => this.switchRelativeWorkspace(1),
      'workspace.previous': () => this.switchRelativeWorkspace(-1),
      'workspace.dismissAttention': ({ workspaceId }) => this.acknowledgeWorkspaceAttention(workspaceId),
      'tab.create': (args) => this.createTab(args),
      'tab.open': (args) => this.openTab(args),
      'tab.rename': (args) => this.renameTab(args),
      'tab.move': (args) => this.moveTab(args),
      'tab.close': (args) => this.closeTab(args),
      'tab.createDefault': () => this.createDefaultTab(),
      'tab.next': () => this.openRelativeTab(1),
      'tab.previous': () => this.openRelativeTab(-1),
      'tab.renameDialog': () => this.tabDialog.open('rename'),
      'tab.closeDialog': () => this.tabDialog.open('close'),
      'pane.focus': ({ paneId }) => this.focusPane(paneId),
      'pane.split': (args) => this.splitPane(args),
      'split.resize': (args) => this.resizeSplit(args),
      'pane.close': (args) => this.closePane(args),
      'pane.detach': (args) => this.detachPane(args),
      'pane.kill': (args) => this.killPaneSession(args),
      'pane.restart': (args) => this.restartPane(args),
      'pane.splitHorizontal': () => this.splitActivePane('horizontal'),
      'pane.splitVertical': () => this.splitActivePane('vertical'),
      'pane.resizeLeft': () => this.resizeActivePane('left'),
      'pane.resizeRight': () => this.resizeActivePane('right'),
      'pane.resizeUp': () => this.resizeActivePane('up'),
      'pane.resizeDown': () => this.resizeActivePane('down'),
      'pane.closeDialog': () => this.paneDialog.open(),
      'pane.next': () => this.focusNextPane(),
      'pane.previous': () => this.focusPreviousPane(),
    }, {
      'palette.open': () => this.closed
        ? 'Application is closing'
        : this.settingsView.isOpen
          ? 'Another overlay is open'
          : this.workspaceDialog.isOpen || this.tabDialog.isOpen || this.paneDialog.isOpen
            ? 'Another overlay is open'
            : this.commandPalette.isOpen ? 'Command palette is already open' : null,
      'palette.close': () => this.commandPalette.isOpen ? null : 'Command palette is not open',
      'settings.open': () => this.closed
        ? 'Application is closing'
        : this.workspaceDialog.isOpen || this.tabDialog.isOpen || this.paneDialog.isOpen
          ? 'Another overlay is open'
          : this.settingsView.isOpen ? 'Settings are already open' : null,
      'settings.close': () => this.settingsView.isOpen ? null : 'Settings are not open',
      'workspace.create': (args) => this.createWorkspaceDisabledReason(args),
      'workspace.rename': (args) => this.renameWorkspaceDisabledReason(args.workspaceId),
      'workspace.delete': (args) => this.deleteWorkspaceDisabledReason(args.workspaceId),
      'workspace.createDialog': () => this.workspaceDialogDisabledReason('create'),
      'workspace.renameDialog': () => this.workspaceDialogDisabledReason('rename'),
      'workspace.deleteDialog': () => this.workspaceDialogDisabledReason('delete'),
      'workspace.open': ({ workspaceId }) => this.workspaceCommandDisabledReason(workspaceId),
      'workspace.next': () => this.relativeWorkspaceCommandDisabledReason(),
      'workspace.previous': () => this.relativeWorkspaceCommandDisabledReason(),
      'workspace.dismissAttention': ({ workspaceId }) => this.dismissAttentionDisabledReason(workspaceId),
      'tab.create': (args) => this.createTabDisabledReason(args),
      'tab.open': (args) => this.tabCommandDisabledReason(args),
      'tab.rename': (args) => this.tabCommandDisabledReason(args),
      'tab.move': (args) => this.moveTabDisabledReason(args),
      'tab.close': (args) => this.closeTabDisabledReason(args),
      'tab.createDefault': () => this.createDefaultTabDisabledReason(),
      'tab.next': () => this.relativeTabCommandDisabledReason(),
      'tab.previous': () => this.relativeTabCommandDisabledReason(),
      'tab.renameDialog': () => this.tabDialogDisabledReason('rename'),
      'tab.closeDialog': () => this.tabDialogDisabledReason('close'),
      'pane.focus': ({ paneId }) => this.paneCommandDisabledReason(paneId),
      'pane.split': (args) => this.splitPaneDisabledReason(args),
      'split.resize': (args) => this.resizeSplitDisabledReason(args),
      'pane.close': (args) => this.closePaneDisabledReason(args),
      'pane.detach': (args) => this.lifecyclePaneDisabledReason(args, 'detach'),
      'pane.kill': (args) => this.lifecyclePaneDisabledReason(args, 'kill'),
      'pane.restart': (args) => this.lifecyclePaneDisabledReason(args, 'restart'),
      'pane.splitHorizontal': () => this.splitActivePaneDisabledReason(),
      'pane.splitVertical': () => this.splitActivePaneDisabledReason(),
      'pane.resizeLeft': () => this.resizeActivePaneDisabledReason('left'),
      'pane.resizeRight': () => this.resizeActivePaneDisabledReason('right'),
      'pane.resizeUp': () => this.resizeActivePaneDisabledReason('up'),
      'pane.resizeDown': () => this.resizeActivePaneDisabledReason('down'),
      'pane.closeDialog': () => this.paneCloseDialogDisabledReason(),
      'pane.next': () => this.relativePaneCommandDisabledReason(),
      'pane.previous': () => this.relativePaneCommandDisabledReason(),
    });
    this.keybindingRouter = new KeybindingRouter(mergeKeybindings(
      this.defaultKeybindings(),
      availableKeybindingOverrides(
        this.config.keybindingOverrides,
        this.allowedKeybindingInvocations(),
      ),
    ));
    this.commandPalette = new CommandPalette({
      documentRef: this.document,
      registry: this.commandRegistry,
      getEntries: () => this.createPaletteEntries(),
      dispatch: (invocation) => this.dispatchCommand(invocation),
      restoreActivePaneFocus: () => this.applyActivePaneFocus(),
    });
    this.settingsView = new SettingsView({
      documentRef: this.document,
      getEntries: () => this.createBindableCommandEntries(),
      getDefaults: () => this.defaultKeybindings(),
      getAllowedInvocations: () => this.allowedKeybindingInvocations(),
      loadSettings: () => this.window.neoncodeDesktop.getSettings(),
      saveSettings: (snapshot) => this.window.neoncodeDesktop.saveSettings(snapshot),
      onSaved: (snapshot) => this.applySavedKeybindings(snapshot.settings.keybindings.overrides),
      closeCommand: () => { void this.dispatchCommand({ id: 'settings.close' }); },
      restoreActivePaneFocus: () => this.applyActivePaneFocus(),
    });
    this.workspaceDialog = new WorkspaceDialog({
      documentRef: this.document,
      getLaunchProfiles: () => this.config.launchProfiles,
      getActiveWorkspace: () => {
        const workspace = this.config.workspaces.find(
          (candidate) => candidate.id === this.activeWorkspaceId,
        );
        return workspace ? { id: workspace.id, name: workspace.name } : null;
      },
      dispatchCreate: (args) => this.dispatchCommand({ id: 'workspace.create', args }),
      dispatchRename: (args) => this.dispatchCommand({ id: 'workspace.rename', args }),
      dispatchDelete: (args) => this.dispatchCommand({ id: 'workspace.delete', args }),
      restoreActivePaneFocus: () => this.applyActivePaneFocus(),
    });
    this.tabDialog = new TabDialog({
      documentRef: this.document,
      getActiveTab: () => {
        const workspaceId = this.activeWorkspaceId;
        if (!workspaceId) return null;
        const layout = this.workspaceLayouts.get(workspaceId);
        const tab = layout?.tabs.find((candidate) => candidate.tabId === layout.activeTabId);
        return tab ? { workspaceId, tabId: tab.tabId, title: tab.title } : null;
      },
      dispatchRename: (args) => this.dispatchCommand({ id: 'tab.rename', args }),
      dispatchClose: (args) => this.dispatchCommand({ id: 'tab.close', args }),
      restoreActivePaneFocus: () => this.applyActivePaneFocus(),
    });
    this.paneDialog = new PaneDialog({
      documentRef: this.document,
      getActivePane: () => {
        const workspaceId = this.activeWorkspaceId;
        const paneId = this.activeLayoutTab()?.focusedPaneId;
        if (!workspaceId || !paneId) return null;
        const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
        const descriptor = workspace?.panes.find((pane) => pane.paneId === paneId);
        return descriptor ? { workspaceId, paneId, title: descriptor.title } : null;
      },
      dispatchClose: (args) => this.dispatchCommand({ id: 'pane.close', args }),
      restoreActivePaneFocus: () => this.applyActivePaneFocus(),
    });
    requiredElement(this.document, 'commands-button').addEventListener('click', () => {
      void this.dispatchCommand({ id: 'palette.open' });
    });
    requiredElement(this.document, 'settings-button').addEventListener('click', () => {
      void this.dispatchCommand({ id: 'settings.open' });
    });
    requiredElement(this.document, 'workspace-create-button').addEventListener('click', () => {
      void this.dispatchCommand({ id: 'workspace.createDialog' });
    });
    requiredElement(this.document, 'tab-create-button').addEventListener('click', () => {
      void this.dispatchCommand({ id: 'tab.createDefault' });
    });
    this.updateCommandsShortcutLabel();
    this.document.addEventListener('keydown', this.onDocumentKeyDown, true);
    this.syncPublicConfiguration();
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

  get activeWorkspaceId(): string | null {
    return this.focusModel.activeWorkspaceId;
  }

  executeCommand(...command: CommandExecutionArguments): Promise<CommandOperationResult> {
    return this.commandRegistry.execute(...command);
  }

  listCommands(): CommandMetadata[] {
    return this.commandRegistry.list();
  }

  syncPublicConfiguration(): void {
    this.sessionModel.setConfiguration({
      valid: this.config.configurationValid,
      configStatus: this.config.diagnostics.configStatus,
      stateStatus: this.config.diagnostics.stateStatus,
      warnings: this.config.diagnostics.warnings,
      errors: this.config.diagnostics.errors,
      persistencePolicy: this.config.persistencePolicy,
      terminal: this.config.terminal,
      activeWorkspaceId: this.activeWorkspaceId ?? this.config.activeWorkspaceId,
      workspaces: this.config.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        defaultLaunchProfile: workspace.defaultLaunchProfile,
        layout: workspace.layout,
        sessions: workspace.panes.map((pane) => ({
          id: pane.sessionKey,
          paneId: pane.paneId,
          title: pane.title,
          sessionId: pane.sessionId,
          launchProfileId: pane.launchProfileId,
          launchProfile: pane.launchProfile,
        })),
      })),
    });
  }

  async dispatchCommand(command: CommandInvocation): Promise<CommandDispatchResult> {
    try {
      return await this.commandRegistry.executeInvocation(command);
    } catch (error) {
      const message = errorMessage(error);
      console.error('command_failed', command.id, error);
      this.setStatus(`Command failed: ${message}`);
      return { status: 'failed', message };
    }
  }

  workspaceDialogDisabledReason(mode: 'create' | 'rename' | 'delete'): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.catalogSaving || this.switching) return 'Workspace catalog update is in progress';
    if (this.settingsView.isOpen || this.workspaceDialog.isOpen || this.tabDialog.isOpen
        || this.paneDialog.isOpen) {
      return 'Another overlay is open';
    }
    if (mode === 'create') {
      if (this.config.workspaces.length >= 16) return 'Workspace limit reached';
      const sessions = this.config.workspaces.reduce((count, workspace) => count + workspace.panes.length, 0);
      if (sessions >= 64) return 'Configured session limit reached';
      return null;
    }
    if (!this.activeWorkspaceId) return 'Workspace is unavailable';
    if (mode === 'delete' && this.config.workspaces.length === 1) {
      return 'Cannot delete the last workspace';
    }
    return null;
  }

  createWorkspaceDisabledReason(args: WorkspaceCreateCommandArgs): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.catalogSaving || this.switching) return 'Workspace catalog update is in progress';
    if (this.config.workspaces.length >= 16) return 'Workspace limit reached';
    const paneCount = this.config.workspaces.reduce((count, workspace) => count + workspace.panes.length, 0);
    if (paneCount >= 64) return 'Configured session limit reached';
    if (this.config.workspaces.some((workspace) => workspace.id === args.workspaceId)) {
      return 'Workspace already exists';
    }
    if (this.config.workspaces.some((workspace) => (
      workspace.panes.some((pane) => pane.sessionKey === args.sessionId)
    ))) return 'Session is already configured';
    if (!Object.hasOwn(this.config.launchProfiles, args.defaultLaunchProfile)) {
      return 'Launch profile is unavailable';
    }
    return null;
  }

  renameWorkspaceDisabledReason(workspaceId: string): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.catalogSaving || this.switching) return 'Workspace catalog update is in progress';
    return this.config.workspaces.some((workspace) => workspace.id === workspaceId)
      ? null
      : 'Workspace is unavailable';
  }

  deleteWorkspaceDisabledReason(workspaceId: string): CommandDisabledReason | null {
    const renameReason = this.renameWorkspaceDisabledReason(workspaceId);
    if (renameReason !== null) return renameReason;
    return this.config.workspaces.length === 1 ? 'Cannot delete the last workspace' : null;
  }

  workspaceCommandDisabledReason(workspaceId: string): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (!this.config.workspaces.some((workspace) => workspace.id === workspaceId)) {
      return 'Workspace is unavailable';
    }
    if (this.switching) return 'Workspace switch is in progress';
    return null;
  }

  relativeWorkspaceCommandDisabledReason(): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.config.workspaces.length === 0) return 'No configured workspace is available';
    if (this.config.workspaces.length === 1) return 'No other workspace is available';
    if (this.switching) return 'Workspace switch is in progress';
    return null;
  }

  dismissAttentionDisabledReason(workspaceId: string): CommandDisabledReason | null {
    const workspaceReason = this.workspaceCommandDisabledReason(workspaceId);
    if (workspaceReason !== null) return workspaceReason;
    const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
    const hasAttention = workspace?.panes.some(
      (pane) => this.workspaceSessionStates.get(pane.sessionId)?.attention !== null,
    ) ?? false;
    return hasAttention ? null : 'Workspace has no attention to dismiss';
  }

  activeLayoutTab(workspaceId = this.activeWorkspaceId): TabLayout | null {
    if (!workspaceId) return null;
    const layout = this.workspaceLayouts.get(workspaceId);
    return layout?.tabs.find((tab) => tab.tabId === layout.activeTabId) ?? null;
  }

  tabCommandDisabledReason(args: TabOpenCommandArgs): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.switching || this.catalogSaving) return 'Workspace switch is in progress';
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!layout) return 'Workspace is unavailable';
    return layout.tabs.some((tab) => tab.tabId === args.tabId) ? null : 'Tab is unavailable';
  }

  createTabDisabledReason(args: TabCreateCommandArgs): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.switching || this.catalogSaving) return 'Workspace catalog update is in progress';
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!workspace || !layout) return 'Workspace is unavailable';
    if (workspace.panes.length >= 8 || layout.tabs.length >= MAX_WORKSPACE_TABS) return 'Tab limit reached';
    const totalSessions = this.config.workspaces.reduce((count, candidate) => count + candidate.panes.length, 0);
    if (totalSessions >= 64) return 'Configured session limit reached';
    if (layoutHasId(layout, args.tabId) || layoutHasId(layout, args.sessionId)
        || args.tabId === args.sessionId) {
      return 'Tab already exists';
    }
    if (this.config.workspaces.some((candidate) => (
      candidate.panes.some((pane) => pane.sessionKey === args.sessionId)
    ))) return 'Session is already configured';
    if (!Object.hasOwn(this.config.launchProfiles, args.launchProfile)) {
      return 'Launch profile is unavailable';
    }
    return null;
  }

  createDefaultTabDisabledReason(): CommandDisabledReason | null {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === this.activeWorkspaceId);
    if (!workspace) return 'Workspace is unavailable';
    const layout = this.workspaceLayouts.get(workspace.id);
    if (!layout) return 'No active tab is available';
    if (this.closed) return 'Application is closing';
    if (this.switching || this.catalogSaving) return 'Workspace catalog update is in progress';
    if (workspace.panes.length >= 8 || layout.tabs.length >= MAX_WORKSPACE_TABS) {
      return 'Tab limit reached';
    }
    const totalSessions = this.config.workspaces.reduce((count, candidate) => count + candidate.panes.length, 0);
    return totalSessions >= 64 ? 'Configured session limit reached' : null;
  }

  moveTabDisabledReason(args: TabMoveCommandArgs): CommandDisabledReason | null {
    const reason = this.tabCommandDisabledReason(args);
    if (reason !== null) return reason;
    const layout = this.workspaceLayouts.get(args.workspaceId);
    return layout && args.toIndex < layout.tabs.length ? null : 'Tab is unavailable';
  }

  closeTabDisabledReason(args: TabCloseCommandArgs): CommandDisabledReason | null {
    const reason = this.tabCommandDisabledReason(args);
    if (reason !== null) return reason;
    return this.workspaceLayouts.get(args.workspaceId)?.tabs.length === 1
      ? 'Cannot close the last tab'
      : null;
  }

  relativeTabCommandDisabledReason(): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.switching || this.catalogSaving) return 'Workspace switch is in progress';
    const layout = this.activeWorkspaceId ? this.workspaceLayouts.get(this.activeWorkspaceId) : undefined;
    if (!layout) return 'No active tab is available';
    return layout.tabs.length === 1 ? 'No other tab is available' : null;
  }

  tabDialogDisabledReason(mode: 'rename' | 'close'): CommandDisabledReason | null {
    if (this.settingsView.isOpen || this.workspaceDialog.isOpen || this.tabDialog.isOpen
        || this.paneDialog.isOpen) {
      return 'Another overlay is open';
    }
    const tab = this.activeLayoutTab();
    if (!tab) return 'No active tab is available';
    if (mode === 'close' && this.workspaceLayouts.get(this.activeWorkspaceId ?? '')?.tabs.length === 1) {
      return 'Cannot close the last tab';
    }
    return this.closed ? 'Application is closing' : null;
  }

  findSplitNode(node: LayoutNode, splitId: string): Extract<LayoutNode, { type: 'split' }> | null {
    if (node.type === 'pane') return null;
    if (node.splitId === splitId) return node;
    return this.findSplitNode(node.first, splitId) ?? this.findSplitNode(node.second, splitId);
  }

  paneCommandDisabledReason(paneId: string): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    const activeTab = this.activeLayoutTab();
    if (!activeTab || !orderedPaneLeaves(activeTab.root).some((pane) => pane.paneId === paneId)) {
      return 'Pane is unavailable';
    }
    return null;
  }

  paneTargetDisabledReason(args: PaneTargetCommandArgs): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.paneOperationBusy || this.catalogSaving || this.switching) {
      return 'Pane operation is in progress';
    }
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!workspace || !layout
        || !workspace.panes.some((pane) => pane.paneId === args.paneId)) {
      return 'Pane is unavailable';
    }
    const activeTab = layout.tabs.find((tab) => tab.tabId === layout.activeTabId);
    if (args.workspaceId !== this.activeWorkspaceId || !activeTab
        || !orderedPaneLeaves(activeTab.root).some((pane) => pane.paneId === args.paneId)) {
      return 'Pane is not in the active tab';
    }
    return null;
  }

  splitPaneDisabledReason(args: PaneSplitCommandArgs): CommandDisabledReason | null {
    const targetReason = this.paneTargetDisabledReason(args);
    if (targetReason !== null) return targetReason;
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!workspace || !layout) return 'Workspace is unavailable';
    if (workspace.panes.length >= MAX_WORKSPACE_PANES) return 'Pane limit reached';
    const totalSessions = this.config.workspaces.reduce(
      (count, candidate) => count + candidate.panes.length,
      0,
    );
    if (totalSessions >= 64) return 'Configured session limit reached';
    if (!Object.hasOwn(this.config.launchProfiles, args.launchProfile)) {
      return 'Launch profile is unavailable';
    }
    if (this.config.workspaces.some((candidate) => (
      candidate.panes.some((pane) => pane.sessionKey === args.sessionId)
    ))) return 'Session is already configured';
    if (layoutHasId(layout, args.sessionId)) return 'Pane is already configured';
    if (layoutHasId(layout, args.splitId)) return 'Split is already configured';
    return null;
  }

  splitActivePaneDisabledReason(): CommandDisabledReason | null {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === this.activeWorkspaceId);
    const paneId = this.activeLayoutTab()?.focusedPaneId;
    if (!workspace || !paneId) return 'No active pane is available';
    const targetReason = this.paneTargetDisabledReason({ workspaceId: workspace.id, paneId });
    if (targetReason !== null) return targetReason;
    if (workspace.panes.length >= MAX_WORKSPACE_PANES) return 'Pane limit reached';
    if (!Object.hasOwn(this.config.launchProfiles, workspace.defaultLaunchProfile)) {
      return 'Launch profile is unavailable';
    }
    const totalSessions = this.config.workspaces.reduce(
      (count, candidate) => count + candidate.panes.length,
      0,
    );
    return totalSessions >= 64 ? 'Configured session limit reached' : null;
  }

  resizeSplitDisabledReason(args: SplitResizeCommandArgs): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.paneOperationBusy || this.catalogSaving || this.switching) {
      return 'Pane operation is in progress';
    }
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const activeTab = layout?.tabs.find((tab) => tab.tabId === layout.activeTabId);
    if (!layout) return 'Workspace is unavailable';
    if (args.workspaceId !== this.activeWorkspaceId || !activeTab) {
      return 'Pane is not in the active tab';
    }
    const split = this.findSplitNode(activeTab.root, args.splitId);
    if (!split) return 'Split is unavailable';
    const nextRatio = Math.min(0.9, Math.max(0.1, split.ratio + args.delta));
    return nextRatio === split.ratio ? 'Split cannot be resized further' : null;
  }

  closePaneDisabledReason(args: PaneCloseCommandArgs): CommandDisabledReason | null {
    const targetReason = this.paneTargetDisabledReason(args);
    if (targetReason !== null) return targetReason;
    const pane = this.panes.find((candidate) => candidate.paneId === args.paneId);
    if (pane?.state && ['killed', 'killing', 'exited'].includes(pane.state.lifecycle)) {
      return 'Pane is already killed';
    }
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const tab = layout?.tabs.find((candidate) => candidate.tabId === layout.activeTabId);
    return tab && orderedPaneLeaves(tab.root).length > 1
      ? null
      : 'Cannot close the last pane in a tab';
  }

  lifecyclePaneDisabledReason(
    args: PaneTargetCommandArgs,
    operation: 'detach' | 'kill' | 'restart',
  ): CommandDisabledReason | null {
    const targetReason = this.paneTargetDisabledReason(args);
    if (targetReason !== null) return targetReason;
    const pane = this.panes.find((candidate) => candidate.paneId === args.paneId);
    if (!pane) return 'Pane is unavailable';
    if (operation === 'detach' && pane.state
        && ['detached', 'detaching'].includes(pane.state.lifecycle)) {
      return 'Pane is already detached';
    }
    if (operation !== 'restart' && pane.state
        && ['killed', 'killing', 'exited'].includes(pane.state.lifecycle)) {
      return 'Pane is already killed';
    }
    return null;
  }

  resizeActivePaneDisabledReason(direction: PaneResizeDirection): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    if (this.paneOperationBusy || this.catalogSaving || this.switching) {
      return 'Pane operation is in progress';
    }
    const tab = this.activeLayoutTab();
    if (!tab) return 'No active pane is available';
    const resize = computeDirectionalResizeDelta(tab.root, tab.focusedPaneId, direction);
    if (!resize) return 'No matching split is available';
    return resize.delta === 0 ? 'Split cannot be resized further' : null;
  }

  paneCloseDialogDisabledReason(): CommandDisabledReason | null {
    if (this.settingsView.isOpen || this.workspaceDialog.isOpen || this.tabDialog.isOpen
        || this.paneDialog.isOpen) {
      return 'Another overlay is open';
    }
    const workspaceId = this.activeWorkspaceId;
    const paneId = this.activeLayoutTab()?.focusedPaneId;
    if (!workspaceId || !paneId) return 'No active pane is available';
    return this.closePaneDisabledReason({ workspaceId, paneId, disposition: 'detach' });
  }

  relativePaneCommandDisabledReason(): CommandDisabledReason | null {
    if (this.closed) return 'Application is closing';
    const paneCount = this.activeLayoutTab() ? orderedPaneLeaves(this.activeLayoutTab()!.root).length : 0;
    if (paneCount === 0) return 'No active pane is available';
    return paneCount === 1 ? 'No other pane is available' : null;
  }

  defaultKeybindings(): Keybinding[] {
    return createDefaultKeybindings(this.config.workspaces.map((workspace) => workspace.id));
  }

  allowedKeybindingInvocations(): CommandInvocation[] {
    return createConcreteCommandInvocations(
      this.config.workspaces.map((workspace) => workspace.id),
      this.config.workspaces.flatMap((workspace) => workspace.panes.map((pane) => pane.paneId)),
    );
  }

  rebuildKeybindingRouter(): void {
    const availableOverrides = availableKeybindingOverrides(
      this.config.keybindingOverrides,
      this.allowedKeybindingInvocations(),
    );
    this.keybindingRouter = new KeybindingRouter(mergeKeybindings(
      this.defaultKeybindings(),
      availableOverrides,
    ));
    this.updateCommandsShortcutLabel();
  }

  applySavedKeybindings(overrides: readonly KeybindingOverride[]): void {
    const validated = validateKeybindingSettings(
      { overrides },
      this.defaultKeybindings(),
      this.allowedKeybindingInvocations(),
    );
    this.config.keybindingOverrides = structuredClone(validated.overrides);
    this.rebuildKeybindingRouter();
  }

  updateCommandsShortcutLabel(): void {
    const label = requiredElement(this.document, 'commands-shortcut');
    label.textContent = this.keybindingRouter.shortcutFor({ id: 'palette.open' }) ?? 'Unbound';
  }

  createBindableCommandEntries(): BindableCommandEntry[] {
    const entries: BindableCommandEntry[] = [
      { invocation: { id: 'palette.open' }, title: getCommandMetadata('palette.open').title },
      { invocation: { id: 'settings.open' }, title: getCommandMetadata('settings.open').title },
      { invocation: { id: 'workspace.createDialog' }, title: getCommandMetadata('workspace.createDialog').title },
      { invocation: { id: 'workspace.renameDialog' }, title: getCommandMetadata('workspace.renameDialog').title },
      { invocation: { id: 'workspace.deleteDialog' }, title: getCommandMetadata('workspace.deleteDialog').title },
      { invocation: { id: 'workspace.next' }, title: getCommandMetadata('workspace.next').title },
      { invocation: { id: 'workspace.previous' }, title: getCommandMetadata('workspace.previous').title },
      { invocation: { id: 'tab.createDefault' }, title: getCommandMetadata('tab.createDefault').title },
      { invocation: { id: 'tab.next' }, title: getCommandMetadata('tab.next').title },
      { invocation: { id: 'tab.previous' }, title: getCommandMetadata('tab.previous').title },
      { invocation: { id: 'tab.renameDialog' }, title: getCommandMetadata('tab.renameDialog').title },
      { invocation: { id: 'tab.closeDialog' }, title: getCommandMetadata('tab.closeDialog').title },
      { invocation: { id: 'pane.splitHorizontal' }, title: getCommandMetadata('pane.splitHorizontal').title },
      { invocation: { id: 'pane.splitVertical' }, title: getCommandMetadata('pane.splitVertical').title },
      { invocation: { id: 'pane.resizeLeft' }, title: getCommandMetadata('pane.resizeLeft').title },
      { invocation: { id: 'pane.resizeRight' }, title: getCommandMetadata('pane.resizeRight').title },
      { invocation: { id: 'pane.resizeUp' }, title: getCommandMetadata('pane.resizeUp').title },
      { invocation: { id: 'pane.resizeDown' }, title: getCommandMetadata('pane.resizeDown').title },
      { invocation: { id: 'pane.closeDialog' }, title: getCommandMetadata('pane.closeDialog').title },
    ];
    for (const workspace of this.config.workspaces) {
      entries.push({
        invocation: { id: 'workspace.open', args: { workspaceId: workspace.id } },
        title: `Open Workspace: ${workspace.name}`,
      });
      for (const pane of workspace.panes) {
        entries.push({
          invocation: { id: 'pane.focus', args: { paneId: pane.paneId } },
          title: `Focus Pane: ${pane.title} (${workspace.name})`,
        });
      }
    }
    entries.push(
      { invocation: { id: 'pane.next' }, title: getCommandMetadata('pane.next').title },
      { invocation: { id: 'pane.previous' }, title: getCommandMetadata('pane.previous').title },
    );
    for (const workspace of this.config.workspaces) {
      entries.push({
        invocation: { id: 'workspace.dismissAttention', args: { workspaceId: workspace.id } },
        title: `Dismiss Attention: ${workspace.name}`,
      });
    }
    return entries;
  }

  createPaletteEntries(): PaletteCommandEntry[] {
    const entries: PaletteCommandEntry[] = [];
    const add = (invocation: CommandInvocation, title: string, additionalSearchTerms: string[] = []): void => {
      const metadata = getCommandMetadata(invocation.id);
      entries.push({
        invocation,
        title,
        category: metadata.category,
        searchTerms: [...metadata.searchTerms, ...additionalSearchTerms],
        shortcut: this.keybindingRouter.shortcutFor(invocation),
      });
    };

    add({ id: 'settings.open' }, getCommandMetadata('settings.open').title);
    add({ id: 'workspace.createDialog' }, getCommandMetadata('workspace.createDialog').title);
    add({ id: 'workspace.renameDialog' }, getCommandMetadata('workspace.renameDialog').title);
    add({ id: 'workspace.deleteDialog' }, getCommandMetadata('workspace.deleteDialog').title);
    add({ id: 'workspace.next' }, getCommandMetadata('workspace.next').title);
    add({ id: 'workspace.previous' }, getCommandMetadata('workspace.previous').title);
    add({ id: 'tab.createDefault' }, getCommandMetadata('tab.createDefault').title);
    add({ id: 'tab.next' }, getCommandMetadata('tab.next').title);
    add({ id: 'tab.previous' }, getCommandMetadata('tab.previous').title);
    add({ id: 'tab.renameDialog' }, getCommandMetadata('tab.renameDialog').title);
    add({ id: 'tab.closeDialog' }, getCommandMetadata('tab.closeDialog').title);
    add({ id: 'pane.splitHorizontal' }, getCommandMetadata('pane.splitHorizontal').title);
    add({ id: 'pane.splitVertical' }, getCommandMetadata('pane.splitVertical').title);
    add({ id: 'pane.resizeLeft' }, getCommandMetadata('pane.resizeLeft').title);
    add({ id: 'pane.resizeRight' }, getCommandMetadata('pane.resizeRight').title);
    add({ id: 'pane.resizeUp' }, getCommandMetadata('pane.resizeUp').title);
    add({ id: 'pane.resizeDown' }, getCommandMetadata('pane.resizeDown').title);
    add({ id: 'pane.closeDialog' }, getCommandMetadata('pane.closeDialog').title);
    for (const workspace of this.config.workspaces) {
      add(
        { id: 'workspace.open', args: { workspaceId: workspace.id } },
        `Open Workspace: ${workspace.name}`,
        [workspace.id, workspace.name],
      );
    }
    const activeWorkspace = this.config.workspaces.find(
      (workspace) => workspace.id === this.activeWorkspaceId,
    );
    for (const pane of activeWorkspace?.panes ?? []) {
      add(
        { id: 'pane.focus', args: { paneId: pane.paneId } },
        `Focus Pane: ${pane.title}`,
        [pane.paneId, pane.title, activeWorkspace?.name ?? ''],
      );
    }
    add({ id: 'pane.next' }, getCommandMetadata('pane.next').title);
    add({ id: 'pane.previous' }, getCommandMetadata('pane.previous').title);
    const activePaneId = this.activeLayoutTab()?.focusedPaneId;
    if (activeWorkspace && activePaneId) {
      const target = { workspaceId: activeWorkspace.id, paneId: activePaneId };
      add({ id: 'pane.detach', args: target }, getCommandMetadata('pane.detach').title);
      add({ id: 'pane.kill', args: target }, getCommandMetadata('pane.kill').title);
      add({ id: 'pane.restart', args: target }, getCommandMetadata('pane.restart').title);
    }
    for (const workspace of this.config.workspaces) {
      add(
        { id: 'workspace.dismissAttention', args: { workspaceId: workspace.id } },
        `Dismiss Attention: ${workspace.name}`,
        [workspace.id, workspace.name, 'notification', 'exit'],
      );
    }
    return entries;
  }

  workspaceConfig(workspace: WorkspaceDescriptor): DesktopWorkspaceConfig {
    return {
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      defaultLaunchProfile: workspace.defaultLaunchProfile,
      layout: { ...workspace.layout },
      sessions: workspace.panes.map((pane) => ({
        id: pane.sessionKey,
        title: pane.title,
        launchProfile: pane.launchProfileId,
      })),
    };
  }

  persistWorkspaceLayout(workspaceId: string, context: string): Promise<boolean> {
    const layout = this.workspaceLayouts.get(workspaceId);
    if (!layout) return Promise.resolve(false);
    const snapshot = validateWorkspaceLayoutState(layout);
    const previous = this.layoutSavePromises.get(workspaceId) ?? Promise.resolve();
    const operation = previous.then(async (): Promise<boolean> => {
      try {
        await this.window.neoncodeDesktop.saveWorkspaceLayout(workspaceId, snapshot);
        return true;
      } catch (error) {
        this.addRuntimeWarning(`${context} could not be persisted: ${errorMessage(error)}. The layout will be reconciled from the session catalog on restart.`);
        return false;
      }
    });
    const queued = operation.then(() => {});
    this.layoutSavePromises.set(workspaceId, queued);
    void queued.finally(() => {
      if (this.layoutSavePromises.get(workspaceId) === queued) {
        this.layoutSavePromises.delete(workspaceId);
      }
    });
    return operation;
  }

  persistInitialWorkspaceLayouts(): void {
    for (const workspaceId of this.pendingInitialLayoutSaves) {
      void this.persistWorkspaceLayout(workspaceId, 'Seeded workspace layout').then((saved) => {
        if (saved) this.pendingInitialLayoutSaves.delete(workspaceId);
      });
    }
  }

  private createLayoutToken(prefix: string, layout: WorkspaceLayoutState): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const nonce = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().toLowerCase()
        : `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}-${attempt}`;
      const candidate = `${prefix}-${nonce}`;
      if (!layoutHasId(layout, candidate)
          && !this.config.workspaces.some((workspace) => (
            workspace.panes.some((pane) => pane.sessionKey === candidate)
          ))) return candidate;
    }
    throw new Error(`could not allocate a unique ${prefix} identifier`);
  }

  async splitActivePane(direction: 'horizontal' | 'vertical'): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === this.activeWorkspaceId);
    const layout = workspace ? this.workspaceLayouts.get(workspace.id) : undefined;
    const paneId = this.activeLayoutTab()?.focusedPaneId;
    if (!workspace || !layout || !paneId) throw new Error('no active pane');
    const sessionId = this.createLayoutToken('session', layout);
    await this.splitPane({
      workspaceId: workspace.id,
      paneId,
      sessionId,
      splitId: this.createLayoutToken('split', layout),
      title: `Terminal ${workspace.panes.length + 1}`,
      launchProfile: workspace.defaultLaunchProfile,
      direction,
      position: 'after',
    });
  }

  async splitPane(args: PaneSplitCommandArgs): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const profile = this.config.launchProfiles[args.launchProfile];
    if (!workspace || !layout) throw new Error(`unknown workspace: ${args.workspaceId}`);
    if (!profile) throw new Error(`launch profile is unavailable: ${args.launchProfile}`);
    const nextLayout = splitLayoutPane(layout, {
      paneId: args.paneId,
      newPaneId: args.sessionId,
      newSessionKey: args.sessionId,
      splitId: args.splitId,
      direction: args.direction,
      position: args.position,
    });

    this.paneOperationBusy = true;
    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      const configured = snapshot.workspaces.find((candidate) => candidate.id === args.workspaceId);
      if (!configured) throw new Error(`unknown workspace: ${args.workspaceId}`);
      if (configured.sessions.length >= MAX_WORKSPACE_PANES) throw new Error('pane limit reached');
      if (snapshot.workspaces.some((candidate) => (
        candidate.sessions.some((session) => session.id === args.sessionId)
      ))) throw new Error(`session is already configured: ${args.sessionId}`);
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: snapshot.workspaces.map((candidate) => candidate.id === args.workspaceId
          ? {
            ...candidate,
            sessions: [...candidate.sessions, {
              id: args.sessionId,
              title: args.title,
              launchProfile: args.launchProfile,
            }],
          }
          : candidate),
      });

      const descriptor: PaneDescriptor = {
        index: workspace.panes.length,
        workspaceId: workspace.id,
        paneId: args.sessionId,
        sessionKey: args.sessionId,
        title: args.title,
        terminalElementId: `terminal-${workspace.id}-${args.sessionId}`,
        sessionId: createSessionId(this.config.sessionPrefix, args.sessionId),
        launchProfileId: args.launchProfile,
        launchProfile: {
          ...profile,
          args: [...profile.args],
          cwd: workspace.path ?? profile.cwd,
        },
      };
      workspace.panes.push(descriptor);
      this.workspaceSessionStates.set(descriptor.sessionId, {
        workspaceId: workspace.id,
        lifecycle: 'idle',
        error: '',
        attention: null,
      });
      this.workspaceLayouts.set(workspace.id, nextLayout);
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      await this.persistWorkspaceLayout(workspace.id, 'Split pane layout');
    } finally {
      this.catalogSaving = false;
      this.paneOperationBusy = false;
    }
    await this.switchWorkspace(workspace.id, { force: true });
  }

  resizeActivePane(direction: PaneResizeDirection): Promise<void> {
    const workspaceId = this.activeWorkspaceId;
    const tab = this.activeLayoutTab();
    if (!workspaceId || !tab) return Promise.resolve();
    const resize = computeDirectionalResizeDelta(tab.root, tab.focusedPaneId, direction);
    if (!resize || resize.delta === 0) return Promise.resolve();
    return this.resizeSplit({ workspaceId, splitId: resize.splitId, delta: resize.delta });
  }

  async resizeSplit(args: SplitResizeCommandArgs): Promise<void> {
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const activeTab = layout?.tabs.find((tab) => tab.tabId === layout.activeTabId);
    const split = activeTab ? this.findSplitNode(activeTab.root, args.splitId) : null;
    if (!layout || !split) throw new Error(`unknown split: ${args.splitId}`);
    const nextRatio = Math.min(0.9, Math.max(0.1, split.ratio + args.delta));
    const nextLayout = resizeSplit(layout, args.splitId, nextRatio);
    this.workspaceLayouts.set(args.workspaceId, nextLayout);
    this.updateSplitSurface(args.splitId, nextRatio);
    for (const pane of this.panes) pane.scheduleFitAndResize();
    await this.persistWorkspaceLayout(args.workspaceId, 'Resized split layout');
  }

  updateSplitSurface(splitId: string, ratio: number): void {
    const split = [...this.terminalGrid.querySelectorAll<HTMLElement>('.layout-split')]
      .find((candidate) => candidate.dataset.splitId === splitId);
    const children = split?.querySelectorAll<HTMLElement>(':scope > .layout-child');
    const first = children?.[0];
    const second = children?.[1];
    if (!first || !second) return;
    first.style.flex = `0 1 ${ratio * 100}%`;
    second.style.flex = `0 1 ${(1 - ratio) * 100}%`;
    split?.querySelector<HTMLElement>(':scope > .layout-separator')
      ?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  private descriptorForPaneTarget(args: PaneTargetCommandArgs): PaneDescriptor | null {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const leaf = this.activeLayoutTab(args.workspaceId)
      ? orderedPaneLeaves(this.activeLayoutTab(args.workspaceId)!.root)
        .find((candidate) => candidate.paneId === args.paneId)
      : undefined;
    return workspace?.panes.find((pane) => pane.sessionKey === leaf?.sessionKey) ?? null;
  }

  private async requestVisiblePaneClose(
    pane: TerminalPane,
    disposition: 'detach' | 'kill',
  ): Promise<void> {
    if (disposition === 'kill' && pane.state.lifecycle === 'detached') {
      await this.controlSession(pane.sessionId, 'kill');
      pane.finishClose('killed');
    } else if (disposition === 'kill') {
      await pane.killAndClose();
    } else {
      await pane.detachAndClose();
    }
    if (pane.state.lifecycle !== (disposition === 'kill' ? 'killed' : 'detached')) {
      throw new Error(pane.state.error || `${disposition} acknowledgement failed`);
    }
  }

  async closePane(args: PaneCloseCommandArgs): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const descriptor = this.descriptorForPaneTarget(args);
    const visiblePane = this.panes.find((pane) => pane.paneId === args.paneId);
    if (!workspace || !layout || !descriptor || !visiblePane) {
      throw new Error(`unknown pane: ${args.workspaceId}/${args.paneId}`);
    }
    const removed = closeLayoutPane(layout, args.paneId);

    this.paneOperationBusy = true;
    this.catalogSaving = true;
    try {
      await this.requestVisiblePaneClose(visiblePane, args.disposition);
      try {
        const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
        await this.window.neoncodeDesktop.saveWorkspaceCatalog({
          revision: snapshot.revision,
          workspaces: snapshot.workspaces.map((candidate) => candidate.id === workspace.id
            ? {
              ...candidate,
              sessions: candidate.sessions.filter((session) => session.id !== descriptor.sessionKey),
            }
            : candidate),
        });
      } catch (error) {
        const warning = `Pane lifecycle completed, but its durable definition could not be removed: ${errorMessage(error)}. The pane was restored.`;
        this.addRuntimeWarning(warning);
        await this.reconstructPane(args.paneId);
        throw error;
      }

      workspace.panes = workspace.panes
        .filter((pane) => pane.sessionKey !== descriptor.sessionKey)
        .map((pane, index) => ({ ...pane, index }));
      this.workspaceLayouts.set(workspace.id, removed.state);
      this.workspaceSessionStates.delete(descriptor.sessionId);
      this.visitedSessionIds.delete(descriptor.sessionId);
      if (args.disposition === 'kill') {
        this.discoveredSessionIds.delete(descriptor.sessionId);
        this.hubSessionsById.delete(descriptor.sessionId);
      }
      const removedTargets = new Set([args.paneId, descriptor.sessionKey]);
      this.config.keybindingOverrides = this.config.keybindingOverrides.filter(({ command }) => (
        command.id !== 'pane.focus' || !removedTargets.has(command.args.paneId)
      ));
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      await this.persistWorkspaceLayout(workspace.id, 'Closed pane layout');
    } finally {
      this.catalogSaving = false;
      this.paneOperationBusy = false;
    }
    await this.switchWorkspace(workspace.id, { force: true });
  }

  async detachPane(args: PaneTargetCommandArgs): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.paneId === args.paneId);
    if (!pane) throw new Error(`unknown visible pane: ${args.paneId}`);
    this.paneOperationBusy = true;
    try {
      await this.requestVisiblePaneClose(pane, 'detach');
      this.setStatus(`Detached ${pane.sessionId}; restart attaches it again`);
    } finally {
      this.paneOperationBusy = false;
    }
  }

  async killPaneSession(args: PaneTargetCommandArgs): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.paneId === args.paneId);
    if (!pane) throw new Error(`unknown visible pane: ${args.paneId}`);
    this.paneOperationBusy = true;
    try {
      await this.requestVisiblePaneClose(pane, 'kill');
      this.setStatus(`Killed ${pane.sessionId}; restart starts a replacement`);
    } finally {
      this.paneOperationBusy = false;
    }
  }

  async restartPane(args: PaneTargetCommandArgs): Promise<void> {
    this.paneOperationBusy = true;
    try {
      await this.reconstructPane(args.paneId);
      this.setStatus(`Restarting or attaching ${args.paneId}`);
    } finally {
      this.paneOperationBusy = false;
    }
  }

  private async reconstructPane(paneId: string): Promise<void> {
    const index = this.panes.findIndex((pane) => pane.paneId === paneId);
    const current = this.panes[index];
    const workspace = this.config.workspaces.find((candidate) => candidate.id === this.activeWorkspaceId);
    const leaf = this.activeLayoutTab()
      ? orderedPaneLeaves(this.activeLayoutTab()!.root).find((pane) => pane.paneId === paneId)
      : undefined;
    if (!current || !workspace || !leaf || index < 0) throw new Error(`unknown visible pane: ${paneId}`);
    const descriptor = this.descriptorForLeaf(workspace, leaf);
    const running = this.hubSessionsById.get(descriptor.sessionId)?.state === 'running'
      || this.discoveredSessionIds.has(descriptor.sessionId);
    if (running) this.discoveredSessionIds.add(descriptor.sessionId);
    else this.discoveredSessionIds.delete(descriptor.sessionId);
    current.dispose();
    const container = this.document.getElementById(descriptor.terminalElementId);
    container?.replaceChildren();
    this.createPane(descriptor, index);
    this.applyActivePaneFocus();
    await Promise.resolve();
  }

  async createTab(args: TabCreateCommandArgs): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!workspace || !layout) throw new Error(`unknown workspace: ${args.workspaceId}`);
    const profile = this.config.launchProfiles[args.launchProfile];
    if (!profile) throw new Error(`launch profile is unavailable: ${args.launchProfile}`);
    const nextLayout = addTab(layout, {
      tabId: args.tabId,
      title: args.title,
      paneId: args.sessionId,
      sessionKey: args.sessionId,
    });

    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      const configured = snapshot.workspaces.find((candidate) => candidate.id === args.workspaceId);
      if (!configured) throw new Error(`unknown workspace: ${args.workspaceId}`);
      if (configured.sessions.length >= 8) throw new Error('configured session limit reached');
      if (snapshot.workspaces.some((candidate) => (
        candidate.sessions.some((session) => session.id === args.sessionId)
      ))) throw new Error(`session is already configured: ${args.sessionId}`);
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: snapshot.workspaces.map((candidate) => candidate.id === args.workspaceId
          ? {
            ...candidate,
            sessions: [...candidate.sessions, {
              id: args.sessionId,
              title: args.title,
              launchProfile: args.launchProfile,
            }],
          }
          : candidate),
      });

      const descriptor: PaneDescriptor = {
        index: workspace.panes.length,
        workspaceId: workspace.id,
        paneId: args.sessionId,
        sessionKey: args.sessionId,
        title: args.title,
        terminalElementId: `terminal-${workspace.id}-${args.sessionId}`,
        sessionId: createSessionId(this.config.sessionPrefix, args.sessionId),
        launchProfileId: args.launchProfile,
        launchProfile: {
          ...profile,
          args: [...profile.args],
          cwd: workspace.path ?? profile.cwd,
        },
      };
      workspace.panes.push(descriptor);
      this.workspaceSessionStates.set(descriptor.sessionId, {
        workspaceId: workspace.id,
        lifecycle: 'idle',
        error: '',
        attention: null,
      });
      this.workspaceLayouts.set(workspace.id, nextLayout);
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      await this.persistWorkspaceLayout(workspace.id, 'New tab layout');
    } finally {
      this.catalogSaving = false;
    }
    await this.switchWorkspace(workspace.id, { force: true });
  }

  async createDefaultTab(): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === this.activeWorkspaceId);
    if (!workspace) throw new Error('no active workspace');
    const nonce = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${workspace.panes.length + 1}`;
    const token = nonce.toLowerCase();
    const ordinal = workspace.panes.length + 1;
    await this.createTab({
      workspaceId: workspace.id,
      tabId: `tab-${token}`,
      title: `Terminal ${ordinal}`,
      sessionId: `session-${token}`,
      launchProfile: workspace.defaultLaunchProfile,
    });
  }

  openTab(args: TabOpenCommandArgs): Promise<void> {
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!layout) return Promise.reject(new Error(`unknown workspace: ${args.workspaceId}`));
    if (layout.activeTabId === args.tabId && args.workspaceId === this.activeWorkspaceId) {
      this.applyActivePaneFocus();
      return Promise.resolve();
    }
    this.workspaceLayouts.set(args.workspaceId, activateTab(layout, args.tabId));
    void this.persistWorkspaceLayout(args.workspaceId, 'Active tab');
    return this.switchWorkspace(args.workspaceId, { force: true });
  }

  openRelativeTab(direction: 1 | -1): Promise<void> {
    const workspaceId = this.activeWorkspaceId;
    const layout = workspaceId ? this.workspaceLayouts.get(workspaceId) : undefined;
    if (!workspaceId || !layout) return Promise.resolve();
    const index = layout.tabs.findIndex((tab) => tab.tabId === layout.activeTabId);
    const target = layout.tabs[(index + direction + layout.tabs.length) % layout.tabs.length];
    return target ? this.openTab({ workspaceId, tabId: target.tabId }) : Promise.resolve();
  }

  async renameTab(args: TabRenameCommandArgs): Promise<void> {
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!layout) throw new Error(`unknown workspace: ${args.workspaceId}`);
    this.workspaceLayouts.set(args.workspaceId, renameTab(layout, args.tabId, args.title));
    if (args.workspaceId === this.activeWorkspaceId) this.renderWorkspaceTabs(args.workspaceId);
    await this.persistWorkspaceLayout(args.workspaceId, 'Renamed tab layout');
    this.rebuildKeybindingRouter();
  }

  async moveTab(args: TabMoveCommandArgs): Promise<void> {
    const layout = this.workspaceLayouts.get(args.workspaceId);
    if (!layout) throw new Error(`unknown workspace: ${args.workspaceId}`);
    this.workspaceLayouts.set(args.workspaceId, moveTab(layout, args.tabId, args.toIndex));
    if (args.workspaceId === this.activeWorkspaceId) this.renderWorkspaceTabs(args.workspaceId);
    await this.persistWorkspaceLayout(args.workspaceId, 'Moved tab layout');
    this.rebuildKeybindingRouter();
  }

  async closeTab(args: TabCloseCommandArgs): Promise<void> {
    const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
    const layout = this.workspaceLayouts.get(args.workspaceId);
    const tab = layout?.tabs.find((candidate) => candidate.tabId === args.tabId);
    if (!workspace || !layout || !tab) throw new Error(`unknown tab: ${args.workspaceId}/${args.tabId}`);
    const removed = closeTab(layout, args.tabId);
    const removedKeys = new Set(removed.removedLeaves.map((leaf) => leaf.sessionKey));
    const removedDescriptors = workspace.panes.filter((pane) => removedKeys.has(pane.sessionKey));
    const wasVisible = workspace.id === this.activeWorkspaceId && layout.activeTabId === tab.tabId;

    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: snapshot.workspaces.map((candidate) => candidate.id === workspace.id
          ? { ...candidate, sessions: candidate.sessions.filter((session) => !removedKeys.has(session.id)) }
          : candidate),
      });

      if (wasVisible) {
        for (const pane of this.panes) {
          if (args.disposition === 'kill') await pane.killAndClose();
          else await pane.detachAndClose();
          pane.dispose();
        }
        this.panes = [];
        this.terminalGrid.replaceChildren();
      } else if (args.disposition === 'kill') {
        for (const descriptor of removedDescriptors) await this.killDetachedSession(descriptor.sessionId);
      }

      workspace.panes = workspace.panes
        .filter((pane) => !removedKeys.has(pane.sessionKey))
        .map((pane, index) => ({ ...pane, index }));
      for (const descriptor of removedDescriptors) {
        this.workspaceSessionStates.delete(descriptor.sessionId);
        this.visitedSessionIds.delete(descriptor.sessionId);
        if (args.disposition === 'kill') {
          this.discoveredSessionIds.delete(descriptor.sessionId);
          this.hubSessionsById.delete(descriptor.sessionId);
        }
      }
      this.workspaceLayouts.set(workspace.id, removed.state);
      const removedPaneIds = new Set(removed.removedLeaves.flatMap((leaf) => [leaf.paneId, leaf.sessionKey]));
      this.config.keybindingOverrides = this.config.keybindingOverrides.filter(({ command }) => (
        command.id !== 'pane.focus' || !removedPaneIds.has(command.args.paneId)
      ));
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      await this.persistWorkspaceLayout(workspace.id, 'Closed tab layout');
    } finally {
      this.catalogSaving = false;
    }

    if (workspace.id === this.activeWorkspaceId) {
      await this.switchWorkspace(workspace.id, { force: true });
    }
  }

  async createWorkspace(args: WorkspaceCreateCommandArgs): Promise<void> {
    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      if (snapshot.workspaces.some((workspace) => workspace.id === args.workspaceId)) {
        throw new Error(`workspace already exists: ${args.workspaceId}`);
      }
      if (snapshot.workspaces.some((workspace) => (
        workspace.sessions.some((session) => session.id === args.sessionId)
      ))) throw new Error(`session is already configured: ${args.sessionId}`);
      const configured: DesktopWorkspaceConfig = {
        id: args.workspaceId,
        name: args.name,
        path: args.path,
        defaultLaunchProfile: args.defaultLaunchProfile,
        layout: { columns: 1 },
        sessions: [{
          id: args.sessionId,
          title: args.title,
          launchProfile: args.defaultLaunchProfile,
        }],
      };
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: [...snapshot.workspaces, configured],
      });

      const profile = this.config.launchProfiles[args.defaultLaunchProfile];
      if (!profile) throw new Error(`launch profile is unavailable: ${args.defaultLaunchProfile}`);
      const descriptor: WorkspaceDescriptor = {
        id: args.workspaceId,
        name: args.name,
        path: args.path,
        defaultLaunchProfile: args.defaultLaunchProfile,
        layout: { columns: 1 },
        panes: [{
          index: 0,
          workspaceId: args.workspaceId,
          paneId: args.sessionId,
          sessionKey: args.sessionId,
          title: args.title,
          terminalElementId: `terminal-${args.workspaceId}-${args.sessionId}`,
          sessionId: createSessionId(this.config.sessionPrefix, args.sessionId),
          launchProfileId: args.defaultLaunchProfile,
          launchProfile: {
            ...profile,
            args: [...profile.args],
            cwd: args.path ?? profile.cwd,
          },
        }],
      };
      this.config.workspaces.push(descriptor);
      const seeded = reconcileWorkspaceLayout({
        name: descriptor.name,
        layout: descriptor.layout,
        sessions: descriptor.panes.map((pane) => ({ id: pane.sessionKey, title: pane.title })),
      });
      this.workspaceLayouts.set(descriptor.id, seeded.state);
      this.focusModel.addWorkspace(
        descriptor.id,
        orderedPaneLeaves(seeded.state.tabs[0]!.root).map((pane) => pane.paneId),
      );
      this.workspaceSessionStates.set(descriptor.panes[0]!.sessionId, {
        workspaceId: descriptor.id,
        lifecycle: 'idle',
        error: '',
        attention: null,
      });
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      this.renderWorkspaceSelector();
      await this.persistWorkspaceLayout(descriptor.id, 'Created workspace layout');
      this.catalogSaving = false;
      await this.switchWorkspace(descriptor.id);
    } finally {
      this.catalogSaving = false;
    }
  }

  async renameWorkspace(args: WorkspaceRenameCommandArgs): Promise<void> {
    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      if (!snapshot.workspaces.some((workspace) => workspace.id === args.workspaceId)) {
        throw new Error(`unknown workspace: ${args.workspaceId}`);
      }
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: snapshot.workspaces.map((workspace) => workspace.id === args.workspaceId
          ? { ...workspace, name: args.name }
          : workspace),
      });
      const workspace = this.config.workspaces.find((candidate) => candidate.id === args.workspaceId);
      if (!workspace) throw new Error(`unknown runtime workspace: ${args.workspaceId}`);
      workspace.name = args.name;
      this.syncPublicConfiguration();
      this.renderWorkspaceSelector();
      if (workspace.id === this.activeWorkspaceId) this.setStatus(`Workspace: ${workspace.name}`);
    } finally {
      this.catalogSaving = false;
    }
  }

  async deleteWorkspace(args: WorkspaceDeleteCommandArgs): Promise<void> {
    const index = this.config.workspaces.findIndex((workspace) => workspace.id === args.workspaceId);
    const deleting = this.config.workspaces[index];
    if (!deleting) throw new Error(`unknown workspace: ${args.workspaceId}`);
    const remaining = this.config.workspaces.filter((workspace) => workspace.id !== args.workspaceId);
    const adjacent = remaining[Math.min(index, remaining.length - 1)];
    if (!adjacent) throw new Error('cannot delete the last workspace');
    const deletingActive = deleting.id === this.activeWorkspaceId;

    this.catalogSaving = true;
    try {
      const snapshot = await this.window.neoncodeDesktop.getWorkspaceCatalog();
      if (snapshot.workspaces.length === 1) throw new Error('cannot delete the last workspace');
      if (!snapshot.workspaces.some((workspace) => workspace.id === args.workspaceId)) {
        throw new Error(`unknown workspace: ${args.workspaceId}`);
      }
      await this.window.neoncodeDesktop.saveWorkspaceCatalog({
        revision: snapshot.revision,
        workspaces: snapshot.workspaces.filter((workspace) => workspace.id !== args.workspaceId),
      });

      if (deletingActive) {
        await Promise.all(this.panes.map((pane) => (
          args.disposition === 'kill' ? pane.killAndClose() : pane.detachAndClose()
        )));
        for (const pane of this.panes) pane.dispose();
        this.panes = [];
        this.terminalGrid.replaceChildren();
      } else if (args.disposition === 'kill') {
        await Promise.all(deleting.panes.map((pane) => this.killDetachedSession(pane.sessionId)));
      }

      this.config.workspaces.splice(index, 1);
      this.workspaceLayouts.delete(deleting.id);
      for (const pane of deleting.panes) {
        this.workspaceSessionStates.delete(pane.sessionId);
        this.visitedSessionIds.delete(pane.sessionId);
        if (args.disposition === 'kill') {
          this.discoveredSessionIds.delete(pane.sessionId);
          this.hubSessionsById.delete(pane.sessionId);
        }
      }
      const deletedPaneTargets = new Set(deleting.panes.flatMap((pane) => [pane.paneId, pane.sessionKey]));
      this.config.keybindingOverrides = this.config.keybindingOverrides.filter(({ command }) => {
        if (command.id === 'workspace.open'
            || command.id === 'workspace.dismissAttention'
            || command.id === 'workspace.rename'
            || command.id === 'workspace.delete') {
          return command.args.workspaceId !== deleting.id;
        }
        return command.id !== 'pane.focus' || !deletedPaneTargets.has(command.args.paneId);
      });
      this.focusModel.removeWorkspace(deleting.id, deletingActive ? adjacent.id : undefined);
      this.syncPublicConfiguration();
      this.rebuildKeybindingRouter();
      this.renderWorkspaceSelector();
      this.catalogSaving = false;
      if (deletingActive) await this.switchWorkspace(adjacent.id, { initial: true });
      else this.applyActivePaneFocus();
    } finally {
      this.catalogSaving = false;
    }
  }

  switchRelativeWorkspace(direction: 1 | -1): Promise<void> {
    const workspaces = this.config.workspaces;
    if (workspaces.length === 0) return Promise.resolve();
    const activeIndex = workspaces.findIndex((workspace) => workspace.id === this.activeWorkspaceId);
    const targetIndex = activeIndex < 0
      ? 0
      : (activeIndex + direction + workspaces.length) % workspaces.length;
    const target = workspaces[targetIndex];
    return target ? this.switchWorkspace(target.id) : Promise.resolve();
  }

  focusPane(paneId: string): void {
    const workspaceId = this.activeWorkspaceId;
    const layout = workspaceId ? this.workspaceLayouts.get(workspaceId) : undefined;
    if (!workspaceId || !layout) throw new Error('no active workspace layout');
    const activeTab = layout.tabs.find((tab) => tab.tabId === layout.activeTabId);
    if (!activeTab || !orderedPaneLeaves(activeTab.root).some((pane) => pane.paneId === paneId)) {
      throw new Error(`unknown pane in active tab: ${paneId}`);
    }
    if (activeTab.focusedPaneId !== paneId) {
      this.workspaceLayouts.set(workspaceId, focusLayoutPane(layout, paneId));
      void this.persistWorkspaceLayout(workspaceId, 'Focused pane');
    }
    this.focusModel.focusPane(paneId);
    this.applyActivePaneFocus();
  }

  focusNextPane(): void {
    this.focusRelativePane(1);
  }

  focusPreviousPane(): void {
    this.focusRelativePane(-1);
  }

  focusRelativePane(direction: 1 | -1): void {
    const tab = this.activeLayoutTab();
    if (!tab) return;
    const panes = orderedPaneLeaves(tab.root);
    const index = panes.findIndex((pane) => pane.paneId === tab.focusedPaneId);
    const target = panes[(index + direction + panes.length) % panes.length];
    if (target) this.focusPane(target.paneId);
  }

  applyActivePaneFocus(): void {
    const activePaneId = this.activeLayoutTab()?.focusedPaneId ?? null;
    this.sessionModel.setActivePane(activePaneId);
    for (const surface of this.terminalGrid.querySelectorAll<HTMLElement>('.terminal-pane')) {
      const active = surface.dataset.paneId === activePaneId;
      surface.dataset.active = String(active);
      surface.dataset.activePane = String(active);
      surface.setAttribute('aria-current', String(active));
    }
    if (activePaneId) {
      this.panes.find((pane) => pane.paneId === activePaneId)?.focus();
    }
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
      const detail = firstAttention.notificationId
        ? `${firstAttention.title}: ${firstAttention.notificationMessage ?? 'Notification'}`
        : `${firstAttention.title} exited with ${firstAttention.status === null ? 'unknown status' : `status ${firstAttention.status}`} (${firstAttention.reason.replaceAll('_', ' ')})`;
      return {
        state: 'attention',
        label: attentionCount === 1 ? 'Needs attention' : `${attentionCount} need attention`,
        detail,
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
        latestNotification: existing?.latestNotification ?? null,
        notificationComplete: existing?.notificationComplete ?? false,
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
      latestNotification: existing?.latestNotification ?? null,
      notificationComplete: existing?.notificationComplete ?? false,
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
        this.dispatchCommand({ id: 'workspace.open', args: { workspaceId: workspace.id } });
      });
      const acknowledge = this.document.createElement('button');
      acknowledge.type = 'button';
      acknowledge.className = 'workspace-attention-button';
      acknowledge.dataset.testid = `workspace-acknowledge-${workspace.id}`;
      acknowledge.textContent = 'Dismiss';
      acknowledge.setAttribute('aria-label', `Dismiss attention for ${workspace.name}`);
      acknowledge.title = `Dismiss attention for ${workspace.name}`;
      acknowledge.hidden = true;
      acknowledge.addEventListener('click', () => {
        acknowledge.disabled = true;
        void this.dispatchCommand({
          id: 'workspace.dismissAttention',
          args: { workspaceId: workspace.id },
        }).finally(() => {
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

  attentionFor(session: NormalizedSessionSummary, title: string): WorkspaceAttention | null {
    if (session.latestExit) {
      return { ...session.latestExit, sessionId: session.sessionId, title };
    }
    if (session.latestNotification) {
      return {
        sessionId: session.sessionId,
        title: session.latestNotification.title || title,
        attentionId: null,
        status: null,
        reason: 'process_exit',
        notificationId: session.latestNotification.notificationId,
        notificationMessage: session.latestNotification.message,
        notificationLevel: session.latestNotification.level,
      };
    }
    return null;
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
    this.persistInitialWorkspaceLayouts();
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
        const attention = this.attentionFor(session, pane?.title || session.sessionId);
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
            const attention = this.attentionFor(session, pane?.title || session.sessionId);
            this.workspaceSessionStates.set(session.sessionId, { ...current, attention });
          }
          this.renderWorkspaceSelector();
          this.updateWorkspaceStatuses();
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

  switchWorkspace(
    workspaceId: string,
    { initial = false, force = false }: WorkspaceSwitchOptions = {},
  ): Promise<void> {
    const operation = this.switchPromise.then(() => (
      this.performWorkspaceSwitch(workspaceId, { initial, force })
    ));
    this.switchPromise = operation.catch(() => {});
    return operation;
  }

  async performWorkspaceSwitch(
    workspaceId: string,
    { initial = false, force = false }: WorkspaceSwitchOptions = {},
  ): Promise<void> {
    if (this.closed) throw new Error('application is closing');
    const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
    const layout = this.workspaceLayouts.get(workspaceId);
    if (!workspace || !layout) throw new Error(`unknown workspace: ${workspaceId}`);
    if (!initial && !force && workspaceId === this.activeWorkspaceId) {
      this.applyActivePaneFocus();
      return;
    }

    this.switching = true;
    this.updateWorkspaceSelector();
    this.setStatus(`Switching to ${workspace.name}...`);
    try {
      if (workspaceId !== this.activeWorkspaceId || initial) {
        try {
          await this.window.neoncodeDesktop.setActiveWorkspace(workspaceId);
        } catch (error) {
          if (!initial) throw error;
          this.addRuntimeWarning(`Active workspace could not be persisted: ${errorMessage(error)}`);
        }
      }
      for (const pane of this.panes) {
        await pane.detachAndClose();
        pane.dispose();
      }
      this.panes = [];
      if (this.closed) return;
      this.terminalGrid.replaceChildren();
      const activeTab = layout.tabs.find((tab) => tab.tabId === layout.activeTabId);
      if (!activeTab) throw new Error(`active tab is unavailable: ${layout.activeTabId}`);
      const leaves = orderedPaneLeaves(activeTab.root);
      this.focusModel.setPaneOrder(workspaceId, leaves.map((leaf) => leaf.paneId));
      this.focusModel.activateWorkspace(workspaceId);
      this.focusModel.focusPane(activeTab.focusedPaneId);
      this.sessionModel.resetPanes(workspaceId);
      this.renderWorkspaceTabs(workspaceId);
      this.updateWorkspaceSelector();
      this.renderLayoutNode(activeTab.root, workspace, this.terminalGrid);
      this.sessionModel.setActiveWorkspace(workspaceId);
      this.applyActivePaneFocus();
      this.setStatus(`Workspace: ${workspace.name}`);
    } finally {
      this.switching = false;
      this.updateWorkspaceSelector();
      const createButton = requiredElement<HTMLButtonElement>(this.document, 'tab-create-button');
      createButton.disabled = this.createDefaultTabDisabledReason() !== null;
    }
  }

  renderWorkspaceTabs(workspaceId: string): void {
    const layout = this.workspaceLayouts.get(workspaceId);
    this.workspaceTabs.replaceChildren();
    if (!layout) return;
    for (const [index, tab] of layout.tabs.entries()) {
      const button = this.document.createElement('button');
      const active = tab.tabId === layout.activeTabId;
      button.type = 'button';
      button.className = 'workspace-tab';
      button.id = `workspace-tab-${workspaceId}-${tab.tabId}`;
      button.dataset.workspaceId = workspaceId;
      button.dataset.tabId = tab.tabId;
      button.dataset.testid = `workspace-tab-${tab.tabId}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('aria-controls', 'terminal-grid');
      button.tabIndex = active ? 0 : -1;
      button.textContent = tab.title;
      button.addEventListener('click', () => {
        void this.dispatchCommand({ id: 'tab.open', args: { workspaceId, tabId: tab.tabId } });
      });
      button.addEventListener('keydown', (event) => {
        let target: TabLayout | undefined;
        if (event.key === 'ArrowRight') target = layout.tabs[(index + 1) % layout.tabs.length];
        else if (event.key === 'ArrowLeft') {
          target = layout.tabs[(index - 1 + layout.tabs.length) % layout.tabs.length];
        } else if (event.key === 'Home') target = layout.tabs[0];
        else if (event.key === 'End') target = layout.tabs.at(-1);
        if (!target) return;
        event.preventDefault();
        void this.dispatchCommand({ id: 'tab.open', args: { workspaceId, tabId: target.tabId } });
      });
      this.workspaceTabs.append(button);
    }
    requiredElement<HTMLButtonElement>(this.document, 'tab-create-button').disabled = (
      this.createDefaultTabDisabledReason() !== null
    );
  }

  descriptorForLeaf(workspace: WorkspaceDescriptor, leaf: PaneLeaf): PaneDescriptor {
    const configured = workspace.panes.find((pane) => pane.sessionKey === leaf.sessionKey);
    if (!configured) throw new Error(`layout references an unconfigured session: ${leaf.sessionKey}`);
    return {
      ...configured,
      paneId: leaf.paneId,
      terminalElementId: `terminal-${workspace.id}-${leaf.paneId}`,
      launchProfile: { ...configured.launchProfile, args: [...configured.launchProfile.args] },
    };
  }

  renderLayoutNode(node: LayoutNode, workspace: WorkspaceDescriptor, parent: HTMLElement): void {
    if (node.type === 'pane') {
      const descriptor = this.descriptorForLeaf(workspace, node);
      this.createPaneSurface(descriptor, parent);
      this.createPane(descriptor);
      this.discoveredSessionIds.add(descriptor.sessionId);
      this.visitedSessionIds.add(descriptor.sessionId);
      return;
    }
    const split = this.document.createElement('div');
    split.className = 'layout-split';
    split.dataset.splitId = node.splitId;
    split.dataset.direction = node.direction;
    const first = this.document.createElement('div');
    first.className = 'layout-child';
    first.style.flex = `0 1 ${node.ratio * 100}%`;
    const separator = this.document.createElement('div');
    separator.className = 'layout-separator';
    separator.dataset.splitId = node.splitId;
    separator.dataset.testid = `split-separator-${node.splitId}`;
    separator.setAttribute('role', 'separator');
    separator.setAttribute('aria-label', `Resize split ${node.splitId}`);
    separator.setAttribute(
      'aria-orientation',
      node.direction === 'horizontal' ? 'vertical' : 'horizontal',
    );
    separator.setAttribute('aria-valuemin', '10');
    separator.setAttribute('aria-valuemax', '90');
    separator.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
    separator.tabIndex = 0;
    separator.addEventListener('keydown', (event) => {
      let delta = 0;
      if (node.direction === 'horizontal' && event.key === 'ArrowLeft') delta = -0.05;
      else if (node.direction === 'horizontal' && event.key === 'ArrowRight') delta = 0.05;
      else if (node.direction === 'vertical' && event.key === 'ArrowUp') delta = -0.05;
      else if (node.direction === 'vertical' && event.key === 'ArrowDown') delta = 0.05;
      if (delta === 0) return;
      event.preventDefault();
      void this.dispatchCommand({
        id: 'split.resize',
        args: { workspaceId: workspace.id, splitId: node.splitId, delta },
      });
    });
    const second = this.document.createElement('div');
    second.className = 'layout-child';
    second.style.flex = `0 1 ${(1 - node.ratio) * 100}%`;
    split.append(first, separator, second);
    parent.append(split);
    this.renderLayoutNode(node.first, workspace, first);
    this.renderLayoutNode(node.second, workspace, second);
  }

  createPaneSurface(descriptor: PaneDescriptor, parent: HTMLElement): void {
    const pane = this.document.createElement('section');
    pane.className = 'terminal-pane';
    pane.dataset.testid = `terminal-pane-${descriptor.paneId}`;
    pane.dataset.paneId = descriptor.paneId;
    pane.dataset.active = 'false';
    pane.dataset.activePane = 'false';
    pane.setAttribute('role', 'group');
    pane.setAttribute('aria-label', `${descriptor.title} terminal pane`);
    pane.setAttribute('aria-current', 'false');
    pane.addEventListener('pointerdown', () => {
      void this.dispatchCommand({ id: 'pane.focus', args: { paneId: descriptor.paneId } });
    });
    pane.addEventListener('focusin', () => {
      void this.dispatchCommand({ id: 'pane.focus', args: { paneId: descriptor.paneId } });
    });

    const titleBar = this.document.createElement('div');
    titleBar.className = 'pane-title';
    const identity = this.document.createElement('span');
    identity.className = 'pane-identity';
    const title = this.document.createElement('span');
    title.className = 'pane-title-text';
    title.textContent = descriptor.title;
    title.dataset.testid = `pane-title-${descriptor.paneId}`;
    const status = this.document.createElement('span');
    status.id = `pane-status-${descriptor.paneId}`;
    status.className = 'pane-status';
    status.dataset.state = 'connecting';
    status.dataset.testid = `pane-status-${descriptor.paneId}`;
    status.textContent = 'Connecting';
    identity.append(title, status);

    const controls = this.document.createElement('span');
    controls.className = 'pane-controls';
    const commandButton = (
      label: string,
      testId: string,
      command: CommandInvocation,
    ): HTMLButtonElement => {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'pane-control';
      button.textContent = label;
      button.title = getCommandMetadata(command.id).title;
      button.setAttribute('aria-label', `${button.title} for ${descriptor.title}`);
      button.dataset.testid = testId;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.focusPane(descriptor.paneId);
        void this.dispatchCommand(command);
      });
      return button;
    };
    const splitButton = commandButton(
      'Split',
      `pane-split-${descriptor.paneId}`,
      { id: 'pane.splitHorizontal' },
    );
    splitButton.disabled = (
      this.config.workspaces.find((workspace) => workspace.id === descriptor.workspaceId)?.panes.length
        ?? MAX_WORKSPACE_PANES
    ) >= MAX_WORKSPACE_PANES;
    const closeButton = commandButton(
      'Close',
      `pane-close-${descriptor.paneId}`,
      { id: 'pane.closeDialog' },
    );
    closeButton.disabled = orderedPaneLeaves(this.activeLayoutTab()?.root ?? {
      type: 'pane', paneId: descriptor.paneId, sessionKey: descriptor.sessionKey,
    }).length === 1;
    const more = this.document.createElement('details');
    more.className = 'pane-more';
    const moreSummary = this.document.createElement('summary');
    moreSummary.className = 'pane-control';
    moreSummary.textContent = 'More';
    moreSummary.setAttribute('aria-label', `More lifecycle controls for ${descriptor.title}`);
    more.append(moreSummary);
    const moreMenu = this.document.createElement('span');
    moreMenu.className = 'pane-more-menu';
    const target = { workspaceId: descriptor.workspaceId, paneId: descriptor.paneId };
    moreMenu.append(
      commandButton('Detach', `pane-detach-${descriptor.paneId}`, { id: 'pane.detach', args: target }),
      commandButton('Kill', `pane-kill-${descriptor.paneId}`, { id: 'pane.kill', args: target }),
      commandButton('Restart', `pane-restart-${descriptor.paneId}`, { id: 'pane.restart', args: target }),
    );
    more.append(moreMenu);
    controls.append(splitButton, closeButton, more);
    titleBar.append(identity, controls);

    const terminal = this.document.createElement('div');
    terminal.id = descriptor.terminalElementId;
    terminal.className = 'terminal';
    terminal.dataset.testid = `terminal-${descriptor.paneId}`;
    pane.append(titleBar, terminal);
    parent.append(pane);
  }

  createPane(descriptor: PaneDescriptor, index = this.panes.length): void {
    const container = this.document.getElementById(descriptor.terminalElementId);
    if (!container) return;
    if (!this.config.terminal) throw new Error('Terminal appearance is unavailable');

    const pane = new TerminalPane({
      index,
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
    if (index === this.panes.length) this.panes.push(pane);
    else this.panes[index] = pane;
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

  acknowledgeSessionNotification(sessionId: string, notificationId: string): Promise<void> {
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
      timeoutHandle = setTimeout(() => finish(new Error('notification acknowledgement timed out')), CONTROL_OPERATION_TIMEOUT_MS);
      client = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        sessionId,
        onOpen: () => {
          if (!client.acknowledgeNotification(notificationId)) finish(new Error('failed to send notification acknowledgement'));
        },
        onMessage: (message) => {
          if (message.type === 'notification_acknowledged'
              && message.session_id === sessionId
              && message.notification_id === notificationId) finish();
          else if (message.type === 'error' && (!message.session_id || message.session_id === sessionId)) {
            finish(new Error(typeof message.message === 'string' ? message.message : 'notification acknowledgement failed'));
          }
        },
        onInvalidMessage: (error) => finish(error instanceof Error ? error : new Error(errorMessage(error))),
        onClose: () => finish(new Error('notification acknowledgement connection closed')),
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
      const attention = this.workspaceSessionStates.get(pane.sessionId)?.attention;
      if (typeof attention?.attentionId === 'string') targets.push({ pane, kind: 'exit', id: attention.attentionId });
      else if (typeof attention?.notificationId === 'string') targets.push({ pane, kind: 'notification', id: attention.notificationId });
    }
    const results = await Promise.allSettled(targets.map((target) => (
      target.kind === 'exit'
        ? this.acknowledgeSessionAttention(target.pane.sessionId, target.id)
        : this.acknowledgeSessionNotification(target.pane.sessionId, target.id)
    )));
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = targets[index];
      if (!target) return;
      const { pane, id: acknowledgedId, kind } = target;
      const current = this.workspaceSessionStates.get(pane.sessionId);
      if (!current?.attention) return;
      const currentId = kind === 'exit' ? current.attention.attentionId : current.attention.notificationId;
      if (currentId !== acknowledgedId) return;
      this.workspaceSessionStates.set(pane.sessionId, { ...current, attention: null });
      const metadata = this.hubSessionsById.get(pane.sessionId);
      if (!metadata) return;
      if (kind === 'notification' && metadata.latestNotification?.notificationId === acknowledgedId) {
        this.hubSessionsById.set(pane.sessionId, { ...metadata, latestNotification: null });
      } else if (kind === 'exit' && metadata.latestExit?.attentionId === acknowledgedId) {
        if (metadata.state === 'exited') this.hubSessionsById.delete(pane.sessionId);
        else this.hubSessionsById.set(pane.sessionId, { ...metadata, latestExit: null });
      }
    });
    this.updateWorkspaceStatuses();
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) throw new Error(`${failed.length} attention acknowledgement(s) failed`);
  }

  controlSession(sessionId: string, action: 'kill'): Promise<void> {
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
        () => finish(new Error(`${action} acknowledgement timed out`)),
        CONTROL_OPERATION_TIMEOUT_MS,
      );
      client = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        sessionId,
        onOpen: () => {
          if (!client.kill()) finish(new Error(`failed to send ${action}`));
        },
        onMessage: (message) => {
          if (message.type === 'killed' && message.session_id === sessionId) finish();
          else if (message.type === 'error'
              && (!message.session_id || message.session_id === sessionId)) {
            finish(new Error(
              typeof message.message === 'string' && message.message
                ? message.message
                : `${action} failed`,
            ));
          }
        },
        onInvalidMessage: (error) => finish(
          error instanceof Error ? error : new Error(errorMessage(error)),
        ),
        onClose: () => finish(new Error(`${action} connection closed before acknowledgement`)),
        onError: () => {},
      });
      client.connect();
    });
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
      await Promise.all(this.layoutSavePromises.values());
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
    this.document.removeEventListener('keydown', this.onDocumentKeyDown, true);
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
