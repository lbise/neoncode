import {
  validateCommandInvocation,
  type CommandInvocation,
} from './command-catalog';

export const MAX_KEYBINDING_OVERRIDES = 64;

export interface KeyCombination {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface Keybinding extends KeyCombination {
  command: CommandInvocation;
}

export interface KeybindingOverride {
  command: CommandInvocation;
  binding: KeyCombination | null;
}

export interface KeybindingSettings {
  overrides: KeybindingOverride[];
}

type UnknownRecord = Record<string, unknown>;

const PHYSICAL_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|Insert|Delete|Backspace|Tab|Enter|Escape|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu)$/u;
const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight', 'AltGraph',
]);
const PRINTABLE_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9]|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Equal|Comma))$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: unknown, expected: readonly string[], label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
  return value;
}

function cloneInvocation(command: CommandInvocation): CommandInvocation {
  return validateCommandInvocation(structuredClone(command));
}

export function commandInvocationSignature(command: CommandInvocation): string {
  switch (command.id) {
    case 'workspace.create':
      return `${command.id}:${JSON.stringify(command.args)}`;
    case 'workspace.rename':
      return `${command.id}:${command.args.workspaceId}:${command.args.name}`;
    case 'workspace.delete':
      return `${command.id}:${command.args.workspaceId}:${command.args.disposition}`;
    case 'workspace.open':
    case 'workspace.dismissAttention':
      return `${command.id}:${command.args.workspaceId}`;
    case 'tab.create':
    case 'tab.rename':
    case 'tab.move':
    case 'tab.close':
      return `${command.id}:${JSON.stringify(command.args)}`;
    case 'tab.open':
      return `${command.id}:${command.args.workspaceId}:${command.args.tabId}`;
    case 'pane.focus':
      return `${command.id}:${command.args.paneId}`;
    default:
      return command.id;
  }
}

export function keyCombinationSignature(
  key: Pick<KeyCombination, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): string {
  return `${key.code}:${Number(key.altKey)}:${Number(key.ctrlKey)}:${Number(key.metaKey)}:${Number(key.shiftKey)}`;
}

function displayCode(code: string): string {
  if (code.startsWith('Digit')) return code.slice('Digit'.length);
  if (code.startsWith('Key')) return code.slice('Key'.length);
  if (code.startsWith('Numpad')) return `Numpad ${code.slice('Numpad'.length)}`;
  const names: Readonly<Record<string, string>> = {
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Space: 'Space',
  };
  return names[code] ?? code;
}

export function formatKeyCombination(binding: KeyCombination): string {
  return [
    binding.ctrlKey ? 'Ctrl' : '',
    binding.altKey ? 'Alt' : '',
    binding.shiftKey ? 'Shift' : '',
    binding.metaKey ? 'Meta' : '',
    displayCode(binding.code),
  ].filter(Boolean).join('+');
}

export function formatKeybinding(binding: Keybinding): string {
  return formatKeyCombination(binding);
}

function protectedTerminalConvention(binding: KeyCombination): boolean {
  if (binding.ctrlKey && !binding.altKey && !binding.metaKey && !binding.shiftKey
      && new Set(['KeyC', 'KeyD', 'KeyZ', 'Space', 'KeyL', 'KeyR', 'KeyA', 'KeyE', 'KeyK', 'KeyU', 'KeyW'])
        .has(binding.code)) {
    return true;
  }
  if (binding.ctrlKey && binding.shiftKey && !binding.altKey && !binding.metaKey
      && (binding.code === 'KeyC' || binding.code === 'KeyV')) {
    return true;
  }
  return binding.shiftKey && !binding.ctrlKey && !binding.altKey && !binding.metaKey
    && binding.code === 'Insert';
}

export function validateKeyCombination(value: unknown, label = 'keybinding'): KeyCombination {
  const binding = requireExactKeys(
    value,
    ['code', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey'],
    label,
  );
  if (typeof binding.code !== 'string' || binding.code.length > 32
      || MODIFIER_CODES.has(binding.code) || !PHYSICAL_CODE_PATTERN.test(binding.code)) {
    throw new Error(`${label}.code must be a supported non-modifier KeyboardEvent.code`);
  }
  if (typeof binding.altKey !== 'boolean'
      || typeof binding.ctrlKey !== 'boolean'
      || typeof binding.metaKey !== 'boolean'
      || typeof binding.shiftKey !== 'boolean') {
    throw new Error(`${label} modifiers must be boolean`);
  }
  const validated: KeyCombination = {
    code: binding.code,
    altKey: binding.altKey,
    ctrlKey: binding.ctrlKey,
    metaKey: binding.metaKey,
    shiftKey: binding.shiftKey,
  };
  if (validated.ctrlKey && validated.altKey) {
    throw new Error(`${label} may not use Ctrl+Alt because it is reserved for AltGraph input`);
  }
  if (PRINTABLE_CODE_PATTERN.test(validated.code)
      && !validated.altKey && !validated.ctrlKey && !validated.metaKey) {
    throw new Error(`${label} may not use a bare printable key or Shift plus a printable key`);
  }
  if (protectedTerminalConvention(validated)) {
    throw new Error(`${formatKeyCombination(validated)} is reserved for terminal input`);
  }
  return validated;
}

export function createConcreteCommandInvocations(
  workspaceIds: readonly string[],
  paneIds: readonly string[],
): CommandInvocation[] {
  return [
    { id: 'palette.open' },
    { id: 'palette.close' },
    { id: 'settings.open' },
    { id: 'settings.close' },
    { id: 'workspace.createDialog' },
    { id: 'workspace.renameDialog' },
    { id: 'workspace.deleteDialog' },
    { id: 'workspace.next' },
    { id: 'workspace.previous' },
    { id: 'tab.createDefault' },
    { id: 'tab.next' },
    { id: 'tab.previous' },
    { id: 'tab.renameDialog' },
    { id: 'tab.closeDialog' },
    { id: 'pane.next' },
    { id: 'pane.previous' },
    ...workspaceIds.flatMap((workspaceId): CommandInvocation[] => [
      { id: 'workspace.open', args: { workspaceId } },
      { id: 'workspace.dismissAttention', args: { workspaceId } },
    ]),
    ...paneIds.map((paneId): CommandInvocation => ({ id: 'pane.focus', args: { paneId } })),
  ];
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
      code: 'KeyT',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      command: { id: 'tab.createDefault' },
    },
    {
      code: 'PageDown',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      command: { id: 'tab.next' },
    },
    {
      code: 'PageUp',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      command: { id: 'tab.previous' },
    },
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

export function mergeKeybindings(
  defaults: readonly Keybinding[],
  overrides: readonly KeybindingOverride[],
): Keybinding[] {
  const merged = new Map<string, Keybinding>();
  for (const binding of defaults) {
    merged.set(commandInvocationSignature(binding.command), {
      ...binding,
      command: cloneInvocation(binding.command),
    });
  }
  for (const override of overrides) {
    const signature = commandInvocationSignature(override.command);
    if (override.binding === null) {
      merged.delete(signature);
    } else {
      merged.set(signature, {
        ...override.binding,
        command: cloneInvocation(override.command),
      });
    }
  }
  return [...merged.values()];
}

export function availableKeybindingOverrides(
  overrides: readonly KeybindingOverride[],
  allowedInvocations: readonly CommandInvocation[],
): KeybindingOverride[] {
  const allowed = new Set(allowedInvocations.map(commandInvocationSignature));
  return overrides
    .filter((override) => allowed.has(commandInvocationSignature(override.command)))
    .map((override) => structuredClone(override));
}

export function validateKeybindingSettings(
  value: unknown,
  defaults: readonly Keybinding[],
  allowedInvocations?: readonly CommandInvocation[],
  { tolerateUnavailable = false }: { tolerateUnavailable?: boolean } = {},
): KeybindingSettings {
  const settings = requireExactKeys(value, ['overrides'], 'keybindings');
  if (!Array.isArray(settings.overrides) || settings.overrides.length > MAX_KEYBINDING_OVERRIDES) {
    throw new Error(`keybindings.overrides must contain at most ${MAX_KEYBINDING_OVERRIDES} entries`);
  }
  const allowed = allowedInvocations
    ? new Set(allowedInvocations.map(commandInvocationSignature))
    : null;
  const seenCommands = new Set<string>();
  const overrides = settings.overrides.map((rawOverride, index): KeybindingOverride => {
    const label = `keybindings.overrides[${index}]`;
    const override = requireExactKeys(rawOverride, ['command', 'binding'], label);
    const command = validateCommandInvocation(override.command);
    const commandSignature = commandInvocationSignature(command);
    if (allowed && !allowed.has(commandSignature) && !tolerateUnavailable) {
      throw new Error(`${label}.command is not a concrete command available in this configuration`);
    }
    if (seenCommands.has(commandSignature)) {
      throw new Error(`${label}.command duplicates another override for the same command invocation`);
    }
    seenCommands.add(commandSignature);
    return {
      command: cloneInvocation(command),
      binding: override.binding === null
        ? null
        : validateKeyCombination(override.binding, `${label}.binding`),
    };
  });

  const effectiveOverrides = allowed && tolerateUnavailable
    ? overrides.filter((override) => allowed.has(commandInvocationSignature(override.command)))
    : overrides;
  const bindings = mergeKeybindings(defaults, effectiveOverrides);
  const seenKeys = new Map<string, CommandInvocation>();
  for (const binding of bindings) {
    const signature = keyCombinationSignature(binding);
    const conflict = seenKeys.get(signature);
    if (conflict) {
      throw new Error(
        `${formatKeybinding(binding)} conflicts between ${commandInvocationSignature(conflict)} and ${commandInvocationSignature(binding.command)}`,
      );
    }
    seenKeys.set(signature, binding.command);
  }
  return { overrides };
}

export function bindingForCommand(
  bindings: readonly Keybinding[],
  command: CommandInvocation,
): Keybinding | null {
  const signature = commandInvocationSignature(command);
  return bindings.find((binding) => commandInvocationSignature(binding.command) === signature) ?? null;
}
