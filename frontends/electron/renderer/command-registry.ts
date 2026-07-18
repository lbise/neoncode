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
  type PaneCloseCommandArgs,
  type PaneFocusCommandArgs,
  type PaneFocusIndexCommandArgs,
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
  type WorkspaceDismissAttentionCommandArgs,
  type WorkspaceOpenCommandArgs,
  type WorkspaceOpenIndexCommandArgs,
  type WorkspaceRenameCommandArgs,
} from '../shared/command-catalog';

export interface CommandHandlers {
  'palette.open': () => void | Promise<void>;
  'palette.close': () => void | Promise<void>;
  'settings.open': () => void | Promise<void>;
  'settings.close': () => void | Promise<void>;
  'workspace.create': (args: WorkspaceCreateCommandArgs) => void | Promise<void>;
  'workspace.rename': (args: WorkspaceRenameCommandArgs) => void | Promise<void>;
  'workspace.delete': (args: WorkspaceDeleteCommandArgs) => void | Promise<void>;
  'workspace.createDialog': () => void | Promise<void>;
  'workspace.renameDialog': () => void | Promise<void>;
  'workspace.deleteDialog': () => void | Promise<void>;
  'workspace.open': (args: WorkspaceOpenCommandArgs) => void | Promise<void>;
  'workspace.openIndex': (args: WorkspaceOpenIndexCommandArgs) => void | Promise<void>;
  'workspace.next': () => void | Promise<void>;
  'workspace.previous': () => void | Promise<void>;
  'workspace.dismissAttention': (args: WorkspaceDismissAttentionCommandArgs) => void | Promise<void>;
  'tab.create': (args: TabCreateCommandArgs) => void | Promise<void>;
  'tab.open': (args: TabOpenCommandArgs) => void | Promise<void>;
  'tab.rename': (args: TabRenameCommandArgs) => void | Promise<void>;
  'tab.move': (args: TabMoveCommandArgs) => void | Promise<void>;
  'tab.close': (args: TabCloseCommandArgs) => void | Promise<void>;
  'tab.createDefault': () => void | Promise<void>;
  'tab.next': () => void | Promise<void>;
  'tab.previous': () => void | Promise<void>;
  'tab.renameDialog': () => void | Promise<void>;
  'tab.closeDialog': () => void | Promise<void>;
  'pane.focus': (args: PaneFocusCommandArgs) => void | Promise<void>;
  'pane.focusIndex': (args: PaneFocusIndexCommandArgs) => void | Promise<void>;
  'pane.split': (args: PaneSplitCommandArgs) => void | Promise<void>;
  'split.resize': (args: SplitResizeCommandArgs) => void | Promise<void>;
  'pane.close': (args: PaneCloseCommandArgs) => void | Promise<void>;
  'pane.kill': (args: PaneTargetCommandArgs) => void | Promise<void>;
  'pane.restart': (args: PaneTargetCommandArgs) => void | Promise<void>;
  'pane.splitHorizontal': () => void | Promise<void>;
  'pane.splitVertical': () => void | Promise<void>;
  'pane.resizeLeft': () => void | Promise<void>;
  'pane.resizeRight': () => void | Promise<void>;
  'pane.resizeUp': () => void | Promise<void>;
  'pane.resizeDown': () => void | Promise<void>;
  'pane.closeDialog': () => void | Promise<void>;
  'pane.next': () => void | Promise<void>;
  'pane.previous': () => void | Promise<void>;
}

export interface CommandEnablement {
  'palette.open'?: () => CommandDisabledReason | null;
  'palette.close'?: () => CommandDisabledReason | null;
  'settings.open'?: () => CommandDisabledReason | null;
  'settings.close'?: () => CommandDisabledReason | null;
  'workspace.create'?: (args: WorkspaceCreateCommandArgs) => CommandDisabledReason | null;
  'workspace.rename'?: (args: WorkspaceRenameCommandArgs) => CommandDisabledReason | null;
  'workspace.delete'?: (args: WorkspaceDeleteCommandArgs) => CommandDisabledReason | null;
  'workspace.createDialog'?: () => CommandDisabledReason | null;
  'workspace.renameDialog'?: () => CommandDisabledReason | null;
  'workspace.deleteDialog'?: () => CommandDisabledReason | null;
  'workspace.open'?:  (args: WorkspaceOpenCommandArgs) => CommandDisabledReason | null;
  'workspace.openIndex'?: (args: WorkspaceOpenIndexCommandArgs) => CommandDisabledReason | null;
  'workspace.next'?: () => CommandDisabledReason | null;
  'workspace.previous'?: () => CommandDisabledReason | null;
  'workspace.dismissAttention'?: (
    args: WorkspaceDismissAttentionCommandArgs,
  ) => CommandDisabledReason | null;
  'tab.create'?: (args: TabCreateCommandArgs) => CommandDisabledReason | null;
  'tab.open'?: (args: TabOpenCommandArgs) => CommandDisabledReason | null;
  'tab.rename'?: (args: TabRenameCommandArgs) => CommandDisabledReason | null;
  'tab.move'?: (args: TabMoveCommandArgs) => CommandDisabledReason | null;
  'tab.close'?: (args: TabCloseCommandArgs) => CommandDisabledReason | null;
  'tab.createDefault'?: () => CommandDisabledReason | null;
  'tab.next'?: () => CommandDisabledReason | null;
  'tab.previous'?: () => CommandDisabledReason | null;
  'tab.renameDialog'?: () => CommandDisabledReason | null;
  'tab.closeDialog'?: () => CommandDisabledReason | null;
  'pane.focus'?: (args: PaneFocusCommandArgs) => CommandDisabledReason | null;
  'pane.focusIndex'?: (args: PaneFocusIndexCommandArgs) => CommandDisabledReason | null;
  'pane.split'?: (args: PaneSplitCommandArgs) => CommandDisabledReason | null;
  'split.resize'?: (args: SplitResizeCommandArgs) => CommandDisabledReason | null;
  'pane.close'?: (args: PaneCloseCommandArgs) => CommandDisabledReason | null;
  'pane.kill'?: (args: PaneTargetCommandArgs) => CommandDisabledReason | null;
  'pane.restart'?: (args: PaneTargetCommandArgs) => CommandDisabledReason | null;
  'pane.splitHorizontal'?: () => CommandDisabledReason | null;
  'pane.splitVertical'?: () => CommandDisabledReason | null;
  'pane.resizeLeft'?: () => CommandDisabledReason | null;
  'pane.resizeRight'?: () => CommandDisabledReason | null;
  'pane.resizeUp'?: () => CommandDisabledReason | null;
  'pane.resizeDown'?: () => CommandDisabledReason | null;
  'pane.closeDialog'?: () => CommandDisabledReason | null;
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
      case 'workspace.create':
        await this.handlers['workspace.create'](invocation.args);
        return completed();
      case 'workspace.rename':
        await this.handlers['workspace.rename'](invocation.args);
        return completed();
      case 'workspace.delete':
        await this.handlers['workspace.delete'](invocation.args);
        return completed();
      case 'workspace.createDialog':
        await this.handlers['workspace.createDialog']();
        return completed();
      case 'workspace.renameDialog':
        await this.handlers['workspace.renameDialog']();
        return completed();
      case 'workspace.deleteDialog':
        await this.handlers['workspace.deleteDialog']();
        return completed();
      case 'workspace.open':
        await this.handlers['workspace.open'](invocation.args);
        return completed();
      case 'workspace.openIndex':
        await this.handlers['workspace.openIndex'](invocation.args);
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
      case 'tab.create':
        await this.handlers['tab.create'](invocation.args);
        return completed();
      case 'tab.open':
        await this.handlers['tab.open'](invocation.args);
        return completed();
      case 'tab.rename':
        await this.handlers['tab.rename'](invocation.args);
        return completed();
      case 'tab.move':
        await this.handlers['tab.move'](invocation.args);
        return completed();
      case 'tab.close':
        await this.handlers['tab.close'](invocation.args);
        return completed();
      case 'tab.createDefault':
        await this.handlers['tab.createDefault']();
        return completed();
      case 'tab.next':
        await this.handlers['tab.next']();
        return completed();
      case 'tab.previous':
        await this.handlers['tab.previous']();
        return completed();
      case 'tab.renameDialog':
        await this.handlers['tab.renameDialog']();
        return completed();
      case 'tab.closeDialog':
        await this.handlers['tab.closeDialog']();
        return completed();
      case 'pane.focus':
        await this.handlers['pane.focus'](invocation.args);
        return completed();
      case 'pane.focusIndex':
        await this.handlers['pane.focusIndex'](invocation.args);
        return completed();
      case 'pane.split':
        await this.handlers['pane.split'](invocation.args);
        return completed();
      case 'split.resize':
        await this.handlers['split.resize'](invocation.args);
        return completed();
      case 'pane.close':
        await this.handlers['pane.close'](invocation.args);
        return completed();
      case 'pane.kill':
        await this.handlers['pane.kill'](invocation.args);
        return completed();
      case 'pane.restart':
        await this.handlers['pane.restart'](invocation.args);
        return completed();
      case 'pane.splitHorizontal':
        await this.handlers['pane.splitHorizontal']();
        return completed();
      case 'pane.splitVertical':
        await this.handlers['pane.splitVertical']();
        return completed();
      case 'pane.resizeLeft':
        await this.handlers['pane.resizeLeft']();
        return completed();
      case 'pane.resizeRight':
        await this.handlers['pane.resizeRight']();
        return completed();
      case 'pane.resizeUp':
        await this.handlers['pane.resizeUp']();
        return completed();
      case 'pane.resizeDown':
        await this.handlers['pane.resizeDown']();
        return completed();
      case 'pane.closeDialog':
        await this.handlers['pane.closeDialog']();
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
      case 'workspace.create':
        return this.enablement['workspace.create']?.(command.args) ?? null;
      case 'workspace.rename':
        return this.enablement['workspace.rename']?.(command.args) ?? null;
      case 'workspace.delete':
        return this.enablement['workspace.delete']?.(command.args) ?? null;
      case 'workspace.createDialog':
        return this.enablement['workspace.createDialog']?.() ?? null;
      case 'workspace.renameDialog':
        return this.enablement['workspace.renameDialog']?.() ?? null;
      case 'workspace.deleteDialog':
        return this.enablement['workspace.deleteDialog']?.() ?? null;
      case 'workspace.open':
        return this.enablement['workspace.open']?.(command.args) ?? null;
      case 'workspace.openIndex':
        return this.enablement['workspace.openIndex']?.(command.args) ?? null;
      case 'workspace.next':
        return this.enablement['workspace.next']?.() ?? null;
      case 'workspace.previous':
        return this.enablement['workspace.previous']?.() ?? null;
      case 'workspace.dismissAttention':
        return this.enablement['workspace.dismissAttention']?.(command.args) ?? null;
      case 'tab.create':
        return this.enablement['tab.create']?.(command.args) ?? null;
      case 'tab.open':
        return this.enablement['tab.open']?.(command.args) ?? null;
      case 'tab.rename':
        return this.enablement['tab.rename']?.(command.args) ?? null;
      case 'tab.move':
        return this.enablement['tab.move']?.(command.args) ?? null;
      case 'tab.close':
        return this.enablement['tab.close']?.(command.args) ?? null;
      case 'tab.createDefault':
        return this.enablement['tab.createDefault']?.() ?? null;
      case 'tab.next':
        return this.enablement['tab.next']?.() ?? null;
      case 'tab.previous':
        return this.enablement['tab.previous']?.() ?? null;
      case 'tab.renameDialog':
        return this.enablement['tab.renameDialog']?.() ?? null;
      case 'tab.closeDialog':
        return this.enablement['tab.closeDialog']?.() ?? null;
      case 'pane.focus':
        return this.enablement['pane.focus']?.(command.args) ?? null;
      case 'pane.focusIndex':
        return this.enablement['pane.focusIndex']?.(command.args) ?? null;
      case 'pane.split':
        return this.enablement['pane.split']?.(command.args) ?? null;
      case 'split.resize':
        return this.enablement['split.resize']?.(command.args) ?? null;
      case 'pane.close':
        return this.enablement['pane.close']?.(command.args) ?? null;
      case 'pane.kill':
        return this.enablement['pane.kill']?.(command.args) ?? null;
      case 'pane.restart':
        return this.enablement['pane.restart']?.(command.args) ?? null;
      case 'pane.splitHorizontal':
        return this.enablement['pane.splitHorizontal']?.() ?? null;
      case 'pane.splitVertical':
        return this.enablement['pane.splitVertical']?.() ?? null;
      case 'pane.resizeLeft':
        return this.enablement['pane.resizeLeft']?.() ?? null;
      case 'pane.resizeRight':
        return this.enablement['pane.resizeRight']?.() ?? null;
      case 'pane.resizeUp':
        return this.enablement['pane.resizeUp']?.() ?? null;
      case 'pane.resizeDown':
        return this.enablement['pane.resizeDown']?.() ?? null;
      case 'pane.closeDialog':
        return this.enablement['pane.closeDialog']?.() ?? null;
      case 'pane.next':
        return this.enablement['pane.next']?.() ?? null;
      case 'pane.previous':
        return this.enablement['pane.previous']?.() ?? null;
    }
  }
}
