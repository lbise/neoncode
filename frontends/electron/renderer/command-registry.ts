import {
  getCommandMetadata,
  listCommandMetadata,
  validateCommandInvocation,
  type CommandAvailability,
  type CommandDescription,
  type CommandDisabledReason,
  type CommandExecutionArguments,
  type CommandInvocation,
  type CommandMetadata,
  type CommandOperationResult,
  type PaneFocusCommandArgs,
  type WorkspaceDismissAttentionCommandArgs,
  type WorkspaceOpenCommandArgs,
} from '../shared/command-catalog';

export interface CommandHandlers {
  'palette.open': () => void | Promise<void>;
  'palette.close': () => void | Promise<void>;
  'settings.open': () => void | Promise<void>;
  'settings.close': () => void | Promise<void>;
  'workspace.open': (args: WorkspaceOpenCommandArgs) => void | Promise<void>;
  'workspace.next': () => void | Promise<void>;
  'workspace.previous': () => void | Promise<void>;
  'workspace.dismissAttention': (args: WorkspaceDismissAttentionCommandArgs) => void | Promise<void>;
  'pane.focus': (args: PaneFocusCommandArgs) => void | Promise<void>;
  'pane.next': () => void | Promise<void>;
  'pane.previous': () => void | Promise<void>;
}

export interface CommandEnablement {
  'palette.open'?: () => CommandDisabledReason | null;
  'palette.close'?: () => CommandDisabledReason | null;
  'settings.open'?: () => CommandDisabledReason | null;
  'settings.close'?: () => CommandDisabledReason | null;
  'workspace.open'?:  (args: WorkspaceOpenCommandArgs) => CommandDisabledReason | null;
  'workspace.next'?: () => CommandDisabledReason | null;
  'workspace.previous'?: () => CommandDisabledReason | null;
  'workspace.dismissAttention'?: (
    args: WorkspaceDismissAttentionCommandArgs,
  ) => CommandDisabledReason | null;
  'pane.focus'?: (args: PaneFocusCommandArgs) => CommandDisabledReason | null;
  'pane.next'?: () => CommandDisabledReason | null;
  'pane.previous'?: () => CommandDisabledReason | null;
}

function completed(): CommandOperationResult {
  return { status: 'completed' };
}

function disabled(reason: CommandDisabledReason): CommandOperationResult {
  return { status: 'disabled', reason };
}

export class CommandRegistry {
  private readonly handlers: CommandHandlers;
  private readonly enablement: CommandEnablement;

  constructor(handlers: CommandHandlers, enablement: CommandEnablement = {}) {
    this.handlers = handlers;
    this.enablement = enablement;
  }

  list(): CommandMetadata[] {
    return listCommandMetadata();
  }

  availability(command: unknown): CommandAvailability {
    const invocation = validateCommandInvocation(command);
    const reason = this.disabledReason(invocation);
    return { enabled: reason === null, disabledReason: reason };
  }

  describe(command: unknown): CommandDescription {
    const invocation = validateCommandInvocation(command);
    return { ...getCommandMetadata(invocation.id), ...this.availability(invocation) };
  }

  async execute(...command: CommandExecutionArguments): Promise<CommandOperationResult> {
    if (command.length === 1) return this.executeInvocation({ id: command[0] });
    if (command.length === 2) {
      return this.executeInvocation({ id: command[0], args: command[1] });
    }
    throw new Error('Invalid command execution arguments');
  }

  async executeInvocation(command: unknown): Promise<CommandOperationResult> {
    const invocation = validateCommandInvocation(command);
    const reason = this.disabledReason(invocation);
    if (reason !== null) return disabled(reason);

    switch (invocation.id) {
      case 'palette.open':
        await this.handlers['palette.open']();
        return completed();
      case 'palette.close':
        await this.handlers['palette.close']();
        return completed();
      case 'settings.open':
        await this.handlers['settings.open']();
        return completed();
      case 'settings.close':
        await this.handlers['settings.close']();
        return completed();
      case 'workspace.open':
        await this.handlers['workspace.open'](invocation.args);
        return completed();
      case 'workspace.next':
        await this.handlers['workspace.next']();
        return completed();
      case 'workspace.previous':
        await this.handlers['workspace.previous']();
        return completed();
      case 'workspace.dismissAttention':
        await this.handlers['workspace.dismissAttention'](invocation.args);
        return completed();
      case 'pane.focus':
        await this.handlers['pane.focus'](invocation.args);
        return completed();
      case 'pane.next':
        await this.handlers['pane.next']();
        return completed();
      case 'pane.previous':
        await this.handlers['pane.previous']();
        return completed();
    }
  }

  private disabledReason(command: CommandInvocation): CommandDisabledReason | null {
    switch (command.id) {
      case 'palette.open':
        return this.enablement['palette.open']?.() ?? null;
      case 'palette.close':
        return this.enablement['palette.close']?.() ?? null;
      case 'settings.open':
        return this.enablement['settings.open']?.() ?? null;
      case 'settings.close':
        return this.enablement['settings.close']?.() ?? null;
      case 'workspace.open':
        return this.enablement['workspace.open']?.(command.args) ?? null;
      case 'workspace.next':
        return this.enablement['workspace.next']?.() ?? null;
      case 'workspace.previous':
        return this.enablement['workspace.previous']?.() ?? null;
      case 'workspace.dismissAttention':
        return this.enablement['workspace.dismissAttention']?.(command.args) ?? null;
      case 'pane.focus':
        return this.enablement['pane.focus']?.(command.args) ?? null;
      case 'pane.next':
        return this.enablement['pane.next']?.() ?? null;
      case 'pane.previous':
        return this.enablement['pane.previous']?.() ?? null;
    }
  }
}
