export const COMMAND_IDS = Object.freeze([
  'palette.open',
  'palette.close',
  'workspace.open',
  'workspace.next',
  'workspace.previous',
  'workspace.dismissAttention',
  'pane.focus',
  'pane.next',
  'pane.previous',
] as const);

export type CommandId = typeof COMMAND_IDS[number];
export type CommandCategory = 'Application' | 'Workspace' | 'Pane';
export type CommandContext = 'application' | 'workspace' | 'pane';
export type CommandOwningLayer = 'renderer' | 'main' | 'hub';

export interface WorkspaceOpenCommandArgs {
  workspaceId: string;
}

export interface WorkspaceDismissAttentionCommandArgs {
  workspaceId: string;
}

export interface PaneFocusCommandArgs {
  paneId: string;
}

export interface CommandArgumentMap {
  'palette.open': undefined;
  'palette.close': undefined;
  'workspace.open': WorkspaceOpenCommandArgs;
  'workspace.next': undefined;
  'workspace.previous': undefined;
  'workspace.dismissAttention': WorkspaceDismissAttentionCommandArgs;
  'pane.focus': PaneFocusCommandArgs;
  'pane.next': undefined;
  'pane.previous': undefined;
}

export type CommandDisabledReason =
  | 'Application is closing'
  | 'Command palette is already open'
  | 'Command palette is not open'
  | 'No configured workspace is available'
  | 'No other workspace is available'
  | 'Workspace is unavailable'
  | 'Workspace switch is in progress'
  | 'Workspace has no attention to dismiss'
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
  'workspace.open': CommandOperationResult;
  'workspace.next': CommandOperationResult;
  'workspace.previous': CommandOperationResult;
  'workspace.dismissAttention': CommandOperationResult;
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
    externalInvocation: false,
  }),
  'workspace.previous': Object.freeze({
    id: 'workspace.previous',
    title: 'Previous Workspace',
    category: 'Workspace',
    context: 'workspace',
    searchTerms: ['switch', 'cycle', 'back'],
    owningLayer: 'renderer',
    externalInvocation: false,
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
  'pane.focus': Object.freeze({
    id: 'pane.focus',
    title: 'Focus Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'select', 'activate'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'pane.next': Object.freeze({
    id: 'pane.next',
    title: 'Focus Next Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'cycle', 'forward'],
    owningLayer: 'renderer',
    externalInvocation: false,
  }),
  'pane.previous': Object.freeze({
    id: 'pane.previous',
    title: 'Focus Previous Pane',
    category: 'Pane',
    context: 'pane',
    searchTerms: ['terminal', 'cycle', 'back'],
    owningLayer: 'renderer',
    externalInvocation: false,
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
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
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
    case 'workspace.next':
    case 'workspace.previous':
    case 'pane.next':
    case 'pane.previous':
      if (!hasExactKeys(value, ['id'])) throw new Error(`Invalid ${value.id} command invocation`);
      return { id: value.id };
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
    case 'pane.focus': {
      if (!hasExactKeys(value, ['id', 'args'])) throw new Error('Invalid pane.focus command invocation');
      const args = validateTargetArgs(value.args, 'paneId');
      return { id: value.id, args };
    }
    default:
      throw new Error(`Unknown command: ${value.id}`);
  }
}
