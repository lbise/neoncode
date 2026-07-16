export const COMMAND_IDS = Object.freeze([
  'palette.open',
  'palette.close',
  'settings.open',
  'settings.close',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.createDialog',
  'workspace.renameDialog',
  'workspace.deleteDialog',
  'workspace.open',
  'workspace.next',
  'workspace.previous',
  'workspace.dismissAttention',
  'tab.create',
  'tab.open',
  'tab.rename',
  'tab.move',
  'tab.close',
  'tab.createDefault',
  'tab.next',
  'tab.previous',
  'tab.renameDialog',
  'tab.closeDialog',
  'pane.focus',
  'pane.next',
  'pane.previous',
] as const);

export type CommandId = typeof COMMAND_IDS[number];
export type CommandCategory = 'Application' | 'Workspace' | 'Tab' | 'Pane';
export type CommandContext = 'application' | 'workspace' | 'tab' | 'pane';
export type CommandOwningLayer = 'renderer' | 'main' | 'hub';

export interface WorkspaceCreateCommandArgs {
  workspaceId: string;
  name: string;
  path: string | null;
  defaultLaunchProfile: string;
  sessionId: string;
  title: string;
}

export interface WorkspaceRenameCommandArgs {
  workspaceId: string;
  name: string;
}

export interface WorkspaceDeleteCommandArgs {
  workspaceId: string;
  disposition: 'detach' | 'kill';
}

export interface WorkspaceOpenCommandArgs {
  workspaceId: string;
}

export interface WorkspaceDismissAttentionCommandArgs {
  workspaceId: string;
}

export interface TabCreateCommandArgs {
  workspaceId: string;
  tabId: string;
  title: string;
  sessionId: string;
  launchProfile: string;
}

export interface TabOpenCommandArgs {
  workspaceId: string;
  tabId: string;
}

export interface TabRenameCommandArgs extends TabOpenCommandArgs {
  title: string;
}

export interface TabMoveCommandArgs extends TabOpenCommandArgs {
  toIndex: number;
}

export interface TabCloseCommandArgs extends TabOpenCommandArgs {
  disposition: 'detach' | 'kill';
}

export interface PaneFocusCommandArgs {
  paneId: string;
}

export interface CommandArgumentMap {
  'palette.open': undefined;
  'palette.close': undefined;
  'settings.open': undefined;
  'settings.close': undefined;
  'workspace.create': WorkspaceCreateCommandArgs;
  'workspace.rename': WorkspaceRenameCommandArgs;
  'workspace.delete': WorkspaceDeleteCommandArgs;
  'workspace.createDialog': undefined;
  'workspace.renameDialog': undefined;
  'workspace.deleteDialog': undefined;
  'workspace.open': WorkspaceOpenCommandArgs;
  'workspace.next': undefined;
  'workspace.previous': undefined;
  'workspace.dismissAttention': WorkspaceDismissAttentionCommandArgs;
  'tab.create': TabCreateCommandArgs;
  'tab.open': TabOpenCommandArgs;
  'tab.rename': TabRenameCommandArgs;
  'tab.move': TabMoveCommandArgs;
  'tab.close': TabCloseCommandArgs;
  'tab.createDefault': undefined;
  'tab.next': undefined;
  'tab.previous': undefined;
  'tab.renameDialog': undefined;
  'tab.closeDialog': undefined;
  'pane.focus': PaneFocusCommandArgs;
  'pane.next': undefined;
  'pane.previous': undefined;
}

export type CommandDisabledReason =
  | 'Application is closing'
  | 'Command palette is already open'
  | 'Command palette is not open'
  | 'Settings are already open'
  | 'Settings are not open'
  | 'Another overlay is open'
  | 'Workspace catalog update is in progress'
  | 'Workspace limit reached'
  | 'Configured session limit reached'
  | 'Workspace already exists'
  | 'Session is already configured'
  | 'Pane is already configured'
  | 'Launch profile is unavailable'
  | 'Cannot delete the last workspace'
  | 'No configured workspace is available'
  | 'No other workspace is available'
  | 'Workspace is unavailable'
  | 'Workspace switch is in progress'
  | 'Workspace has no attention to dismiss'
  | 'Tab limit reached'
  | 'Tab already exists'
  | 'Cannot close the last tab'
  | 'No active tab is available'
  | 'No other tab is available'
  | 'Tab is unavailable'
  | 'No active pane is available'
  | 'No other pane is available'
  | 'Pane is unavailable';

export type CommandOperationResult =
  | { status: 'completed' }
  | { status: 'disabled'; reason: CommandDisabledReason };

export type CommandDispatchResult =
  | CommandOperationResult
  | { status: 'failed'; message: string };

export interface CommandResultMap {
  'palette.open': CommandOperationResult;
  'palette.close': CommandOperationResult;
  'settings.open': CommandOperationResult;
  'settings.close': CommandOperationResult;
  'workspace.create': CommandOperationResult;
  'workspace.rename': CommandOperationResult;
  'workspace.delete': CommandOperationResult;
  'workspace.createDialog': CommandOperationResult;
  'workspace.renameDialog': CommandOperationResult;
  'workspace.deleteDialog': CommandOperationResult;
  'workspace.open': CommandOperationResult;
  'workspace.next': CommandOperationResult;
  'workspace.previous': CommandOperationResult;
  'workspace.dismissAttention': CommandOperationResult;
  'tab.create': CommandOperationResult;
  'tab.open': CommandOperationResult;
  'tab.rename': CommandOperationResult;
  'tab.move': CommandOperationResult;
  'tab.close': CommandOperationResult;
  'tab.createDefault': CommandOperationResult;
  'tab.next': CommandOperationResult;
  'tab.previous': CommandOperationResult;
  'tab.renameDialog': CommandOperationResult;
  'tab.closeDialog': CommandOperationResult;
  'pane.focus': CommandOperationResult;
  'pane.next': CommandOperationResult;
  'pane.previous': CommandOperationResult;
}

export type CommandArguments<K extends CommandId> = CommandArgumentMap[K];
export type CommandResult<K extends CommandId> = CommandResultMap[K];

export type CommandInvocation = {
  [K in CommandId]: CommandArgumentMap[K] extends undefined
    ? { id: K }
    : { id: K; args: CommandArgumentMap[K] }
}[CommandId];

export type CommandExecutionArguments = {
  [K in CommandId]: CommandArgumentMap[K] extends undefined
    ? [commandId: K]
    : [commandId: K, args: CommandArgumentMap[K]]
}[CommandId];

export interface CommandMetadata {
  id: CommandId;
  title: string;
  category: CommandCategory;
  context: CommandContext;
  searchTerms: string[];
  owningLayer: CommandOwningLayer;
  externalInvocation: boolean;
}

export interface CommandAvailability {
  enabled: boolean;
  disabledReason: CommandDisabledReason | null;
}

export interface CommandDescription extends CommandMetadata, CommandAvailability {}

const CATALOG: Readonly<Record<CommandId, Readonly<CommandMetadata>>> = Object.freeze({
  'palette.open': Object.freeze({
    id: 'palette.open',
    title: 'Open Command Palette',
    category: 'Application',
    context: 'application',
    searchTerms: ['commands', 'search', 'actions'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'palette.close': Object.freeze({
    id: 'palette.close',
    title: 'Close Command Palette',
    category: 'Application',
    context: 'application',
    searchTerms: ['commands', 'dismiss', 'escape'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'settings.open': Object.freeze({
    id: 'settings.open',
    title: 'Open Settings',
    category: 'Application',
    context: 'application',
    searchTerms: ['preferences', 'configuration', 'keyboard', 'general'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'settings.close': Object.freeze({
    id: 'settings.close',
    title: 'Close Settings',
    category: 'Application',
    context: 'application',
    searchTerms: ['preferences', 'dismiss', 'escape'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'workspace.create': Object.freeze({
    id: 'workspace.create',
    title: 'Create Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['new', 'project', 'folder'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.rename': Object.freeze({
    id: 'workspace.rename',
    title: 'Rename Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['edit', 'name', 'project'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.delete': Object.freeze({
    id: 'workspace.delete',
    title: 'Delete Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['remove', 'detach', 'kill'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.createDialog': Object.freeze({
    id: 'workspace.createDialog',
    title: 'Create Workspace…',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['new', 'project', 'folder'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'workspace.renameDialog': Object.freeze({
    id: 'workspace.renameDialog',
    title: 'Rename Current Workspace…',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['edit', 'name', 'project'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'workspace.deleteDialog': Object.freeze({
    id: 'workspace.deleteDialog',
    title: 'Delete Current Workspace…',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['remove', 'detach', 'kill'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'workspace.open': Object.freeze({
    id: 'workspace.open',
    title: 'Open Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['switch', 'project', 'context'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.next': Object.freeze({
    id: 'workspace.next',
    title: 'Next Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['switch', 'cycle', 'forward'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.previous': Object.freeze({
    id: 'workspace.previous',
    title: 'Previous Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['switch', 'cycle', 'back'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'workspace.dismissAttention': Object.freeze({
    id: 'workspace.dismissAttention',
    title: 'Dismiss Workspace Attention',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['acknowledge', 'notification', 'exit', 'error'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.create': Object.freeze({
    id: 'tab.create',
    title: 'Create Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['new', 'terminal', 'session'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.open': Object.freeze({
    id: 'tab.open',
    title: 'Open Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['switch', 'activate', 'terminal'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.rename': Object.freeze({
    id: 'tab.rename',
    title: 'Rename Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['edit', 'title'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.move': Object.freeze({
    id: 'tab.move',
    title: 'Move Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['reorder', 'position'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.close': Object.freeze({
    id: 'tab.close',
    title: 'Close Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['remove', 'detach', 'kill'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'tab.createDefault': Object.freeze({
    id: 'tab.createDefault',
    title: 'New Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['create', 'terminal', 'session'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'tab.next': Object.freeze({
    id: 'tab.next',
    title: 'Next Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['switch', 'cycle', 'forward'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'tab.previous': Object.freeze({
    id: 'tab.previous',
    title: 'Previous Tab',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['switch', 'cycle', 'back'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'tab.renameDialog': Object.freeze({
    id: 'tab.renameDialog',
    title: 'Rename Current Tab…',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['edit', 'title'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'tab.closeDialog': Object.freeze({
    id: 'tab.closeDialog',
    title: 'Close Current Tab…',
    category: 'Tab',
    context: 'tab',
    searchTerms: ['remove', 'detach', 'kill'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'pane.focus': Object.freeze({
    id: 'pane.focus',
    title: 'Focus Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'select', 'activate'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'pane.next': Object.freeze({
    id: 'pane.next',
    title: 'Focus Next Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'cycle', 'forward'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
  'pane.previous': Object.freeze({
    id: 'pane.previous',
    title: 'Focus Previous Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'cycle', 'back'],
    owningLayer: 'renderer',
    externalInvocation: true,
  }),
});

function copyMetadata(metadata: Readonly<CommandMetadata>): CommandMetadata {
  return { ...metadata, searchTerms: [...metadata.searchTerms] };
}

export function listCommandMetadata(): CommandMetadata[] {
  return COMMAND_IDS.map((id) => copyMetadata(CATALOG[id]));
}

export function getCommandMetadata(commandId: CommandId): CommandMetadata {
  return copyMetadata(CATALOG[commandId]);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
}

function isBoundedLabel(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && new TextEncoder().encode(value).length <= 64
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isWorkspacePath(value: unknown): value is string | null {
  return value === null || (typeof value === 'string'
    && value.length > 0
    && new TextEncoder().encode(value).length <= 4096
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
}

function validateTargetArgs(value: unknown, key: 'workspaceId' | 'paneId'): Record<typeof key, string> {
  if (!isRecord(value) || !hasExactKeys(value, [key]) || !isBoundedIdentifier(value[key])) {
    throw new Error(`Invalid command arguments: expected a bounded ${key}`);
  }
  return { [key]: value[key] } as Record<typeof key, string>;
}

export function validateCommandInvocation(value: unknown): CommandInvocation {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Invalid command invocation');
  }
  switch (value.id) {
    case 'palette.open':
    case 'palette.close':
    case 'settings.open':
    case 'settings.close':
    case 'workspace.createDialog':
    case 'workspace.renameDialog':
    case 'workspace.deleteDialog':
    case 'workspace.next':
    case 'workspace.previous':
    case 'tab.createDefault':
    case 'tab.next':
    case 'tab.previous':
    case 'tab.renameDialog':
    case 'tab.closeDialog':
    case 'pane.next':
    case 'pane.previous':
      if (!hasExactKeys(value, ['id'])) throw new Error(`Invalid ${value.id} command invocation`);
      return { id: value.id };
    case 'workspace.create': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, [
            'workspaceId', 'name', 'path', 'defaultLaunchProfile', 'sessionId', 'title',
          ])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedLabel(value.args.name)
          || !isWorkspacePath(value.args.path)
          || !isBoundedIdentifier(value.args.defaultLaunchProfile)
          || !isBoundedIdentifier(value.args.sessionId)
          || !isBoundedLabel(value.args.title)) {
        throw new Error('Invalid workspace.create command arguments');
      }
      return {
        id: value.id,
        args: {
          workspaceId: value.args.workspaceId,
          name: value.args.name,
          path: value.args.path,
          defaultLaunchProfile: value.args.defaultLaunchProfile,
          sessionId: value.args.sessionId,
          title: value.args.title,
        },
      };
    }
    case 'workspace.rename': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'name'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedLabel(value.args.name)) {
        throw new Error('Invalid workspace.rename command arguments');
      }
      return { id: value.id, args: { workspaceId: value.args.workspaceId, name: value.args.name } };
    }
    case 'workspace.delete': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'disposition'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || (value.args.disposition !== 'detach' && value.args.disposition !== 'kill')) {
        throw new Error('Invalid workspace.delete command arguments');
      }
      return {
        id: value.id,
        args: { workspaceId: value.args.workspaceId, disposition: value.args.disposition },
      };
    }
    case 'workspace.open': {
      if (!hasExactKeys(value, ['id', 'args'])) throw new Error('Invalid workspace.open command invocation');
      const args = validateTargetArgs(value.args, 'workspaceId');
      return { id: value.id, args };
    }
    case 'workspace.dismissAttention': {
      if (!hasExactKeys(value, ['id', 'args'])) {
        throw new Error('Invalid workspace.dismissAttention command invocation');
      }
      const args = validateTargetArgs(value.args, 'workspaceId');
      return { id: value.id, args };
    }
    case 'tab.create': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'tabId', 'title', 'sessionId', 'launchProfile'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedIdentifier(value.args.tabId)
          || !isBoundedLabel(value.args.title)
          || !isBoundedIdentifier(value.args.sessionId)
          || !isBoundedIdentifier(value.args.launchProfile)) {
        throw new Error('Invalid tab.create command arguments');
      }
      return { id: value.id, args: {
        workspaceId: value.args.workspaceId,
        tabId: value.args.tabId,
        title: value.args.title,
        sessionId: value.args.sessionId,
        launchProfile: value.args.launchProfile,
      } };
    }
    case 'tab.open': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'tabId'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedIdentifier(value.args.tabId)) {
        throw new Error('Invalid tab.open command arguments');
      }
      return { id: value.id, args: { workspaceId: value.args.workspaceId, tabId: value.args.tabId } };
    }
    case 'tab.rename': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'tabId', 'title'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedIdentifier(value.args.tabId)
          || !isBoundedLabel(value.args.title)) {
        throw new Error('Invalid tab.rename command arguments');
      }
      return { id: value.id, args: {
        workspaceId: value.args.workspaceId, tabId: value.args.tabId, title: value.args.title,
      } };
    }
    case 'tab.move': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'tabId', 'toIndex'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedIdentifier(value.args.tabId)
          || typeof value.args.toIndex !== 'number'
          || !Number.isInteger(value.args.toIndex)
          || value.args.toIndex < 0
          || value.args.toIndex > 7) {
        throw new Error('Invalid tab.move command arguments');
      }
      return { id: value.id, args: {
        workspaceId: value.args.workspaceId, tabId: value.args.tabId, toIndex: value.args.toIndex,
      } };
    }
    case 'tab.close': {
      if (!hasExactKeys(value, ['id', 'args']) || !isRecord(value.args)
          || !hasExactKeys(value.args, ['workspaceId', 'tabId', 'disposition'])
          || !isBoundedIdentifier(value.args.workspaceId)
          || !isBoundedIdentifier(value.args.tabId)
          || (value.args.disposition !== 'detach' && value.args.disposition !== 'kill')) {
        throw new Error('Invalid tab.close command arguments');
      }
      return { id: value.id, args: {
        workspaceId: value.args.workspaceId,
        tabId: value.args.tabId,
        disposition: value.args.disposition,
      } };
    }
    case 'pane.focus': {
      if (!hasExactKeys(value, ['id', 'args'])) throw new Error('Invalid pane.focus command invocation');
      const args = validateTargetArgs(value.args, 'paneId');
      return { id: value.id, args };
    }
    default:
      throw new Error(`Unknown command: ${value.id}`);
  }
}
