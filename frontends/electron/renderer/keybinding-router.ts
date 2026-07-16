import type { CommandInvocation } from '../shared/command-catalog';

export interface KeybindingInput {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altGraphKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
}

export interface Keybinding {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  command: CommandInvocation;
}

export type KeybindingResolution =
  | { claimed: false }
  | { claimed: true; execute: false }
  | { claimed: true; execute: true; command: CommandInvocation };

function keySignature(key: Pick<KeybindingInput, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): string {
  return `${key.code}:${Number(key.altKey)}:${Number(key.ctrlKey)}:${Number(key.metaKey)}:${Number(key.shiftKey)}`;
}

function commandSignature(command: CommandInvocation): string {
  switch (command.id) {
    case 'workspace.open':
    case 'workspace.dismissAttention':
      return `${command.id}:${command.args.workspaceId}`;
    case 'pane.focus':
      return `${command.id}:${command.args.paneId}`;
    default:
      return command.id;
  }
}

function displayCode(code: string): string {
  if (code.startsWith('Digit')) return code.slice('Digit'.length);
  if (code.startsWith('Key')) return code.slice('Key'.length);
  return code;
}

export function formatKeybinding(binding: Keybinding): string {
  return [
    binding.ctrlKey ? 'Ctrl' : '',
    binding.altKey ? 'Alt' : '',
    binding.shiftKey ? 'Shift' : '',
    binding.metaKey ? 'Meta' : '',
    displayCode(binding.code),
  ].filter(Boolean).join('+');
}

export function createDefaultKeybindings(workspaceIds: readonly string[]): Keybinding[] {
  const workspaceBindings = workspaceIds.slice(0, 9).map((workspaceId, index): Keybinding => ({
    code: `Digit${index + 1}`,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    command: { id: 'workspace.open', args: { workspaceId } },
  }));
  return [
    {
      code: 'KeyP',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      command: { id: 'palette.open' },
    },
    ...workspaceBindings,
    {
      code: 'F6',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      command: { id: 'pane.next' },
    },
    {
      code: 'F6',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      command: { id: 'pane.previous' },
    },
  ];
}

export class KeybindingRouter {
  private readonly bindingsByKey = new Map<string, CommandInvocation>();
  private readonly shortcutByCommand = new Map<string, string>();

  constructor(bindings: readonly Keybinding[]) {
    for (const binding of bindings) {
      const signature = keySignature(binding);
      if (this.bindingsByKey.has(signature)) {
        throw new Error(`duplicate keybinding: ${signature}`);
      }
      this.bindingsByKey.set(signature, binding.command);
      const commandKey = commandSignature(binding.command);
      if (!this.shortcutByCommand.has(commandKey)) {
        this.shortcutByCommand.set(commandKey, formatKeybinding(binding));
      }
    }
  }

  shortcutFor(command: CommandInvocation): string | null {
    return this.shortcutByCommand.get(commandSignature(command)) ?? null;
  }

  resolve(input: KeybindingInput): KeybindingResolution {
    if (input.defaultPrevented || input.altGraphKey || (input.ctrlKey && input.altKey)) {
      return { claimed: false };
    }
    const command = this.bindingsByKey.get(keySignature(input));
    if (!command) return { claimed: false };
    if (input.repeat) return { claimed: true, execute: false };
    return { claimed: true, execute: true, command };
  }
}
