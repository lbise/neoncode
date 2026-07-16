import {
  commandInvocationSignature,
  formatKeybinding,
  keyCombinationSignature,
  type Keybinding,
} from '../shared/keybindings';
import type { CommandInvocation } from '../shared/command-catalog';

export {
  createDefaultKeybindings,
  formatKeybinding,
  mergeKeybindings,
  validateKeybindingSettings,
} from '../shared/keybindings';
export type { Keybinding } from '../shared/keybindings';

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

export type KeybindingResolution =
  | { claimed: false }
  | { claimed: true; execute: false }
  | { claimed: true; execute: true; command: CommandInvocation };

export class KeybindingRouter {
  private readonly bindingsByKey = new Map<string, CommandInvocation>();
  private readonly shortcutByCommand = new Map<string, string>();

  constructor(bindings: readonly Keybinding[]) {
    for (const binding of bindings) {
      const signature = keyCombinationSignature(binding);
      if (this.bindingsByKey.has(signature)) {
        throw new Error(`duplicate keybinding: ${signature}`);
      }
      this.bindingsByKey.set(signature, binding.command);
      const commandKey = commandInvocationSignature(binding.command);
      if (!this.shortcutByCommand.has(commandKey)) {
        this.shortcutByCommand.set(commandKey, formatKeybinding(binding));
      }
    }
  }

  shortcutFor(command: CommandInvocation): string | null {
    return this.shortcutByCommand.get(commandInvocationSignature(command)) ?? null;
  }

  resolve(input: KeybindingInput): KeybindingResolution {
    if (input.defaultPrevented || input.altGraphKey || (input.ctrlKey && input.altKey)) {
      return { claimed: false };
    }
    const command = this.bindingsByKey.get(keyCombinationSignature(input));
    if (!command) return { claimed: false };
    if (input.repeat) return { claimed: true, execute: false };
    return { claimed: true, execute: true, command };
  }
}
