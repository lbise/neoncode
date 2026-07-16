import type { CommandInvocation } from '../shared/types';

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

  constructor(bindings: readonly Keybinding[]) {
    for (const binding of bindings) {
      const signature = keySignature(binding);
      if (this.bindingsByKey.has(signature)) {
        throw new Error(`duplicate keybinding: ${signature}`);
      }
      this.bindingsByKey.set(signature, binding.command);
    }
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
