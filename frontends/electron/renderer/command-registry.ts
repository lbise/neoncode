import type {
  CommandExecutionArguments,
  CommandId,
  CommandInvocation,
  CommandMetadata,
  PaneFocusCommandArgs,
  WorkspaceOpenCommandArgs,
} from '../shared/types';

export interface CommandHandlers {
  'workspace.open': (args: WorkspaceOpenCommandArgs) => void | Promise<void>;
  'workspace.next': () => void | Promise<void>;
  'workspace.previous': () => void | Promise<void>;
  'pane.focus': (args: PaneFocusCommandArgs) => void | Promise<void>;
  'pane.next': () => void | Promise<void>;
  'pane.previous': () => void | Promise<void>;
}

const COMMAND_ORDER: readonly CommandId[] = Object.freeze([
  'workspace.open',
  'workspace.next',
  'workspace.previous',
  'pane.focus',
  'pane.next',
  'pane.previous',
]);

const COMMANDS: Readonly<Record<CommandId, CommandMetadata>> = Object.freeze({
  'workspace.open': Object.freeze({
    id: 'workspace.open',
    title: 'Open Workspace',
    category: 'Workspace',
    context: 'workspace',
  }),
  'workspace.next': Object.freeze({
    id: 'workspace.next',
    title: 'Next Workspace',
    category: 'Workspace',
    context: 'workspace',
  }),
  'workspace.previous': Object.freeze({
    id: 'workspace.previous',
    title: 'Previous Workspace',
    category: 'Workspace',
    context: 'workspace',
  }),
  'pane.focus': Object.freeze({
    id: 'pane.focus',
    title: 'Focus Pane',
    category: 'Pane',
    context: 'pane',
  }),
  'pane.next': Object.freeze({
    id: 'pane.next',
    title: 'Focus Next Pane',
    category: 'Pane',
    context: 'pane',
  }),
  'pane.previous': Object.freeze({
    id: 'pane.previous',
    title: 'Focus Previous Pane',
    category: 'Pane',
    context: 'pane',
  }),
});

export class CommandRegistry {
  private readonly handlers: CommandHandlers;

  constructor(handlers: CommandHandlers) {
    this.handlers = handlers;
  }

  list(): CommandMetadata[] {
    return COMMAND_ORDER.map((id) => ({ ...COMMANDS[id] }));
  }

  async execute(...command: CommandExecutionArguments): Promise<void> {
    switch (command[0]) {
      case 'workspace.open':
        await this.handlers['workspace.open'](command[1]);
        return;
      case 'workspace.next':
        await this.handlers['workspace.next']();
        return;
      case 'workspace.previous':
        await this.handlers['workspace.previous']();
        return;
      case 'pane.focus':
        await this.handlers['pane.focus'](command[1]);
        return;
      case 'pane.next':
        await this.handlers['pane.next']();
        return;
      case 'pane.previous':
        await this.handlers['pane.previous']();
        return;
    }
    throw new Error('Unknown command');
  }

  executeInvocation(command: CommandInvocation): Promise<void> {
    switch (command.id) {
      case 'workspace.open':
        return this.execute(command.id, command.args);
      case 'workspace.next':
        return this.execute(command.id);
      case 'workspace.previous':
        return this.execute(command.id);
      case 'pane.focus':
        return this.execute(command.id, command.args);
      case 'pane.next':
        return this.execute(command.id);
      case 'pane.previous':
        return this.execute(command.id);
    }
  }
}
