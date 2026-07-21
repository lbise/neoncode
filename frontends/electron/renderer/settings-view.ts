import type { CommandInvocation } from '../shared/command-catalog';
import {
  bindingForCommand,
  commandInvocationSignature,
  formatKeybinding,
  mergeKeybindings,
  validateKeybindingSettings,
  type KeyCombination,
  type Keybinding,
  type KeybindingOverride,
} from '../shared/keybindings';
import type {
  AppTheme,
  DesktopSettings,
  SettingsSnapshot,
} from '../shared/types';

export interface BindableCommandEntry {
  invocation: CommandInvocation;
  title: string;
}

interface SettingsViewOptions {
  documentRef: Document;
  getEntries: () => BindableCommandEntry[];
  getDefaults: () => Keybinding[];
  getAllowedInvocations: () => CommandInvocation[];
  loadSettings: () => Promise<SettingsSnapshot>;
  saveSettings: (snapshot: SettingsSnapshot) => Promise<SettingsSnapshot>;
  onSaved: (snapshot: SettingsSnapshot) => void;
  onClosed: () => void;
  closeCommand: () => void;
  restoreActivePaneFocus: () => void;
}

function requiredElement<T extends HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing Settings element: #${id}`);
  return element as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneSettings(settings: DesktopSettings): DesktopSettings {
  return structuredClone(settings);
}

interface AppThemePreset {
  id: string;
  name: string;
  theme: AppTheme;
}

const APP_THEME_PRESETS: AppThemePreset[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    theme: {
      sidebarBackground: '#111111',
      appBackground: '#0b0b0c',
      terminalBackground: '#050505',
      textColor: '#d6d6d6',
      accent: '#6f7782',
      secondaryAccent: '#32363d',
      tertiaryAccent: '#1a1b1e',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    theme: {
      sidebarBackground: '#1f2128',
      appBackground: '#17191f',
      terminalBackground: '#0f1117',
      textColor: '#dcdee6',
      accent: '#7f848e',
      secondaryAccent: '#3b4048',
      tertiaryAccent: '#282c34',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    theme: {
      sidebarBackground: '#16161e',
      appBackground: '#0f0f14',
      terminalBackground: '#09090d',
      textColor: '#c0caf5',
      accent: '#7aa2f7',
      secondaryAccent: '#2f3549',
      tertiaryAccent: '#1f2335',
    },
  },
];

function normalizeColor(value: string): string {
  return value.trim().toLowerCase();
}

function themeMatchesPreset(theme: AppTheme, preset: AppThemePreset): boolean {
  return Object.entries(preset.theme).every(([key, value]) => (
    normalizeColor(theme[key as keyof AppTheme]) === normalizeColor(value)
  ));
}

function matchingPresetId(theme: AppTheme): string {
  return APP_THEME_PRESETS.find((preset) => themeMatchesPreset(theme, preset))?.id ?? 'custom';
}

const COMMON_FONT_FAMILIES = [
  'Consolas, monospace',
  'Cascadia Mono, monospace',
  'Cascadia Code, monospace',
  'JetBrains Mono, monospace',
  'Fira Code, monospace',
  'Source Code Pro, monospace',
  'Ubuntu Mono, monospace',
  'DejaVu Sans Mono, monospace',
  'Menlo, monospace',
  'Monaco, monospace',
  'monospace',
];

const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32];

function normalizedHexColor(value: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function pickerColor(value: string): string {
  const normalized = normalizedHexColor(value);
  return /^#[0-9a-f]{6}$/u.test(normalized) ? normalized : '#000000';
}

function primaryFontFamily(value: string): string {
  return value.split(',')[0]?.trim().replace(/^['"]|['"]$/gu, '') ?? value;
}

function quotedFontFamily(value: string): string {
  return `"${value.replace(/["\\]/gu, '')}"`;
}

function measuredWidth(context: CanvasRenderingContext2D, fontFamily: string): number {
  context.font = `14px ${fontFamily}`;
  return context.measureText('mmmmmmmmmiiiiiiiii000000000').width;
}

function likelyInstalledFontFamilies(documentRef: Document): string[] {
  const canvas = documentRef.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return COMMON_FONT_FAMILIES;
  const mono = measuredWidth(context, 'monospace');
  const sans = measuredWidth(context, 'sans-serif');
  const serif = measuredWidth(context, 'serif');
  const detected = COMMON_FONT_FAMILIES.filter((family) => {
    if (family === 'monospace') return true;
    const primary = quotedFontFamily(primaryFontFamily(family));
    const width = measuredWidth(context, `${primary}, monospace`);
    return width !== mono && width !== sans && width !== serif;
  });
  return [...new Set([...detected, ...COMMON_FONT_FAMILIES])];
}

function button(documentRef: Document, text: string, testId: string): HTMLButtonElement {
  const result = documentRef.createElement('button');
  result.type = 'button';
  result.className = 'keybinding-action';
  result.textContent = text;
  result.dataset.testid = testId;
  return result;
}

export class SettingsView {
  private readonly document: Document;
  private readonly getEntries: () => BindableCommandEntry[];
  private readonly getDefaults: () => Keybinding[];
  private readonly getAllowedInvocations: () => CommandInvocation[];
  private readonly loadSettings: () => Promise<SettingsSnapshot>;
  private readonly saveSettings: (snapshot: SettingsSnapshot) => Promise<SettingsSnapshot>;
  private readonly onSaved: (snapshot: SettingsSnapshot) => void;
  private readonly onClosed: () => void;
  private readonly closeCommand: () => void;
  private readonly restoreActivePaneFocus: () => void;
  private readonly overlay: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly triggerButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly generalTab: HTMLButtonElement;
  private readonly keyboardTab: HTMLButtonElement;
  private readonly generalPanel: HTMLElement;
  private readonly keyboardPanel: HTMLElement;
  private readonly keybindingList: HTMLElement;
  private readonly errorElement: HTMLElement;
  private readonly statusElement: HTMLElement;
  private readonly confirmBeforeClosingTab: HTMLInputElement;
  private readonly confirmBeforeClosingTerminal: HTMLInputElement;
  private readonly fontFamilyChoice: HTMLSelectElement;
  private readonly fontFamilyCustomLabel: HTMLElement;
  private readonly fontFamily: HTMLInputElement;
  private readonly fontSize: HTMLSelectElement;
  private readonly cursorBlink: HTMLInputElement;
  private readonly background: HTMLInputElement;
  private readonly backgroundPicker: HTMLInputElement;
  private readonly foreground: HTMLInputElement;
  private readonly foregroundPicker: HTMLInputElement;
  private readonly themePreset: HTMLSelectElement;
  private readonly sidebarBackground: HTMLInputElement;
  private readonly sidebarBackgroundPicker: HTMLInputElement;
  private readonly appBackground: HTMLInputElement;
  private readonly appBackgroundPicker: HTMLInputElement;
  private readonly terminalBackground: HTMLInputElement;
  private readonly terminalBackgroundPicker: HTMLInputElement;
  private readonly textColor: HTMLInputElement;
  private readonly textColorPicker: HTMLInputElement;
  private readonly accent: HTMLInputElement;
  private readonly accentPicker: HTMLInputElement;
  private readonly secondaryAccent: HTMLInputElement;
  private readonly secondaryAccentPicker: HTMLInputElement;
  private readonly tertiaryAccent: HTMLInputElement;
  private readonly tertiaryAccentPicker: HTMLInputElement;
  private snapshot: SettingsSnapshot | null = null;
  private draftOverrides: KeybindingOverride[] = [];
  private recordingCommand: CommandInvocation | null = null;
  private saving = false;
  private opening = false;

  constructor({
    documentRef,
    getEntries,
    getDefaults,
    getAllowedInvocations,
    loadSettings,
    saveSettings,
    onSaved,
    onClosed,
    closeCommand,
    restoreActivePaneFocus,
  }: SettingsViewOptions) {
    this.document = documentRef;
    this.getEntries = getEntries;
    this.getDefaults = getDefaults;
    this.getAllowedInvocations = getAllowedInvocations;
    this.loadSettings = loadSettings;
    this.saveSettings = saveSettings;
    this.onSaved = onSaved;
    this.onClosed = onClosed;
    this.closeCommand = closeCommand;
    this.restoreActivePaneFocus = restoreActivePaneFocus;
    this.overlay = requiredElement(documentRef, 'settings-overlay');
    this.form = requiredElement<HTMLFormElement>(documentRef, 'settings-dialog');
    this.triggerButton = requiredElement<HTMLButtonElement>(documentRef, 'settings-button');
    this.closeButton = requiredElement<HTMLButtonElement>(documentRef, 'settings-close');
    this.cancelButton = requiredElement<HTMLButtonElement>(documentRef, 'settings-cancel');
    this.saveButton = requiredElement<HTMLButtonElement>(documentRef, 'settings-save');
    this.generalTab = requiredElement<HTMLButtonElement>(documentRef, 'settings-general-tab');
    this.keyboardTab = requiredElement<HTMLButtonElement>(documentRef, 'settings-keyboard-tab');
    this.generalPanel = requiredElement(documentRef, 'settings-general-panel');
    this.keyboardPanel = requiredElement(documentRef, 'settings-keyboard-panel');
    this.keybindingList = requiredElement(documentRef, 'settings-keybindings');
    this.errorElement = requiredElement(documentRef, 'settings-error');
    this.statusElement = requiredElement(documentRef, 'settings-status');
    this.confirmBeforeClosingTab = requiredElement<HTMLInputElement>(documentRef, 'settings-confirm-before-closing-tab');
    this.confirmBeforeClosingTerminal = requiredElement<HTMLInputElement>(documentRef, 'settings-confirm-before-closing-terminal');
    this.fontFamilyChoice = requiredElement<HTMLSelectElement>(documentRef, 'settings-font-family-choice');
    this.fontFamilyCustomLabel = requiredElement<HTMLElement>(documentRef, 'settings-font-family-custom-label');
    this.fontFamily = requiredElement<HTMLInputElement>(documentRef, 'settings-font-family');
    this.fontSize = requiredElement<HTMLSelectElement>(documentRef, 'settings-font-size');
    this.cursorBlink = requiredElement<HTMLInputElement>(documentRef, 'settings-cursor-blink');
    this.background = requiredElement<HTMLInputElement>(documentRef, 'settings-background');
    this.backgroundPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-background-picker');
    this.foreground = requiredElement<HTMLInputElement>(documentRef, 'settings-foreground');
    this.foregroundPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-foreground-picker');
    this.themePreset = requiredElement<HTMLSelectElement>(documentRef, 'settings-theme-preset');
    this.sidebarBackground = requiredElement<HTMLInputElement>(documentRef, 'settings-sidebar-background');
    this.sidebarBackgroundPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-sidebar-background-picker');
    this.appBackground = requiredElement<HTMLInputElement>(documentRef, 'settings-app-background');
    this.appBackgroundPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-app-background-picker');
    this.terminalBackground = requiredElement<HTMLInputElement>(documentRef, 'settings-terminal-background');
    this.terminalBackgroundPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-terminal-background-picker');
    this.textColor = requiredElement<HTMLInputElement>(documentRef, 'settings-text-color');
    this.textColorPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-text-color-picker');
    this.accent = requiredElement<HTMLInputElement>(documentRef, 'settings-accent');
    this.accentPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-accent-picker');
    this.secondaryAccent = requiredElement<HTMLInputElement>(documentRef, 'settings-secondary-accent');
    this.secondaryAccentPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-secondary-accent-picker');
    this.tertiaryAccent = requiredElement<HTMLInputElement>(documentRef, 'settings-tertiary-accent');
    this.tertiaryAccentPicker = requiredElement<HTMLInputElement>(documentRef, 'settings-tertiary-accent-picker');

    this.populateFontOptions();
    this.populateFontSizeOptions();
    this.populateThemePresetOptions();
    this.fontFamilyChoice.addEventListener('change', () => this.applySelectedFontFamily());
    this.fontFamily.addEventListener('input', () => this.syncFontFamilySelection());
    this.themePreset.addEventListener('change', () => this.applySelectedThemePreset());
    for (const [text, picker, onTextInput] of [
      [this.background, this.backgroundPicker, undefined],
      [this.foreground, this.foregroundPicker, undefined],
      [this.sidebarBackground, this.sidebarBackgroundPicker, () => this.syncThemePresetSelection()],
      [this.appBackground, this.appBackgroundPicker, () => this.syncThemePresetSelection()],
      [this.terminalBackground, this.terminalBackgroundPicker, () => this.syncThemePresetSelection()],
      [this.textColor, this.textColorPicker, () => this.syncThemePresetSelection()],
      [this.accent, this.accentPicker, () => this.syncThemePresetSelection()],
      [this.secondaryAccent, this.secondaryAccentPicker, () => this.syncThemePresetSelection()],
      [this.tertiaryAccent, this.tertiaryAccentPicker, () => this.syncThemePresetSelection()],
    ] as Array<[HTMLInputElement, HTMLInputElement, (() => void) | undefined]>) {
      this.bindColorInputs(text, picker, onTextInput);
    }
    this.generalTab.addEventListener('click', () => this.showPanel('general'));
    this.keyboardTab.addEventListener('click', () => this.showPanel('keyboard'));
    this.closeButton.addEventListener('click', () => this.closeCommand());
    this.cancelButton.addEventListener('click', () => this.closeCommand());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.performSave();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  async open(): Promise<void> {
    if (this.isOpen || this.opening) return;
    this.opening = true;
    this.overlay.hidden = false;
    this.triggerButton.setAttribute('aria-expanded', 'true');
    this.setBusy(true);
    this.statusElement.textContent = 'Loading settings…';
    this.clearError();
    this.showPanel('general');
    this.closeButton.focus({ preventScroll: true });
    try {
      const loaded = await this.loadSettings();
      if (!this.isOpen) return;
      this.snapshot = { revision: loaded.revision, settings: cloneSettings(loaded.settings) };
      this.draftOverrides = structuredClone(loaded.settings.keybindings.overrides);
      this.populateGeneral(loaded.settings);
      this.renderKeybindings();
      this.statusElement.textContent = '';
      this.setBusy(false);
      this.syncFontFamilySelection();
      this.generalTab.focus({ preventScroll: true });
    } catch (error) {
      this.showError(`Settings could not be loaded: ${errorMessage(error)}`);
      this.statusElement.textContent = '';
      this.closeButton.disabled = false;
      this.cancelButton.disabled = false;
    } finally {
      this.opening = false;
    }
  }

  close(): void {
    if (!this.isOpen || this.saving) return;
    this.recordingCommand = null;
    this.snapshot = null;
    this.draftOverrides = [];
    this.overlay.hidden = true;
    this.triggerButton.setAttribute('aria-expanded', 'false');
    this.clearError();
    this.onClosed();
    this.restoreActivePaneFocus();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    event.stopImmediatePropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      if (event.repeat) return true;
      if (this.recordingCommand) {
        this.recordingCommand = null;
        this.statusElement.textContent = 'Shortcut recording cancelled.';
        this.clearError();
        this.renderKeybindings();
      } else if (!this.saving) {
        this.closeCommand();
      }
      return true;
    }

    if (this.recordingCommand) {
      event.preventDefault();
      if (!event.repeat) this.recordKey(event);
      return true;
    }

    if (event.key === 'Tab') {
      this.trapTab(event);
      return true;
    }
    return true;
  }

  private showPanel(panel: 'general' | 'keyboard'): void {
    const general = panel === 'general';
    this.generalTab.setAttribute('aria-selected', String(general));
    this.keyboardTab.setAttribute('aria-selected', String(!general));
    this.generalPanel.hidden = !general;
    this.keyboardPanel.hidden = general;
  }

  private populateFontOptions(): void {
    this.fontFamilyChoice.replaceChildren();
    for (const family of likelyInstalledFontFamilies(this.document)) {
      const option = this.document.createElement('option');
      option.value = family;
      option.textContent = family;
      this.fontFamilyChoice.append(option);
    }
    const custom = this.document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom…';
    this.fontFamilyChoice.append(custom);
  }

  private populateFontSizeOptions(): void {
    this.fontSize.replaceChildren();
    for (const size of FONT_SIZE_OPTIONS) {
      const option = this.document.createElement('option');
      option.value = String(size);
      option.textContent = `${size}px`;
      this.fontSize.append(option);
    }
  }

  private ensureFontSizeOption(size: number): void {
    const value = String(size);
    if ([...this.fontSize.options].some((option) => option.value === value)) return;
    const option = this.document.createElement('option');
    option.value = value;
    option.textContent = `${size}px`;
    const next = [...this.fontSize.options].find((candidate) => Number(candidate.value) > size);
    this.fontSize.insertBefore(option, next ?? null);
  }

  private bindColorInputs(text: HTMLInputElement, picker: HTMLInputElement, onTextInput?: () => void): void {
    text.addEventListener('input', () => {
      picker.value = pickerColor(text.value);
      onTextInput?.();
    });
    picker.addEventListener('input', () => {
      text.value = picker.value;
      text.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  private syncColorPickers(): void {
    for (const [text, picker] of [
      [this.background, this.backgroundPicker],
      [this.foreground, this.foregroundPicker],
      [this.sidebarBackground, this.sidebarBackgroundPicker],
      [this.appBackground, this.appBackgroundPicker],
      [this.terminalBackground, this.terminalBackgroundPicker],
      [this.textColor, this.textColorPicker],
      [this.accent, this.accentPicker],
      [this.secondaryAccent, this.secondaryAccentPicker],
      [this.tertiaryAccent, this.tertiaryAccentPicker],
    ] as Array<[HTMLInputElement, HTMLInputElement]>) {
      picker.value = pickerColor(text.value);
    }
  }

  private populateThemePresetOptions(): void {
    this.themePreset.replaceChildren();
    for (const preset of APP_THEME_PRESETS) {
      const option = this.document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      this.themePreset.append(option);
    }
    const custom = this.document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom';
    this.themePreset.append(custom);
  }

  private applySelectedFontFamily(): void {
    if (this.fontFamilyChoice.value === 'custom') {
      this.fontFamilyCustomLabel.hidden = false;
      this.fontFamily.hidden = false;
      this.fontFamily.disabled = false;
      this.fontFamily.required = true;
      return;
    }
    this.fontFamily.value = this.fontFamilyChoice.value;
    this.fontFamilyCustomLabel.hidden = true;
    this.fontFamily.hidden = true;
    this.fontFamily.disabled = true;
    this.fontFamily.required = false;
  }

  private syncFontFamilySelection(): void {
    const match = COMMON_FONT_FAMILIES.find((family) => family === this.fontFamily.value);
    this.fontFamilyChoice.value = match ?? 'custom';
    const custom = !match;
    this.fontFamilyCustomLabel.hidden = !custom;
    this.fontFamily.hidden = !custom;
    this.fontFamily.disabled = !custom;
    this.fontFamily.required = custom;
  }

  private currentAppThemeDraft(): AppTheme {
    return {
      sidebarBackground: this.sidebarBackground.value,
      appBackground: this.appBackground.value,
      terminalBackground: this.terminalBackground.value,
      textColor: this.textColor.value,
      accent: this.accent.value,
      secondaryAccent: this.secondaryAccent.value,
      tertiaryAccent: this.tertiaryAccent.value,
    };
  }

  private applySelectedThemePreset(): void {
    const preset = APP_THEME_PRESETS.find((candidate) => candidate.id === this.themePreset.value);
    if (!preset) return;
    this.sidebarBackground.value = preset.theme.sidebarBackground;
    this.appBackground.value = preset.theme.appBackground;
    this.terminalBackground.value = preset.theme.terminalBackground;
    this.textColor.value = preset.theme.textColor;
    this.accent.value = preset.theme.accent;
    this.secondaryAccent.value = preset.theme.secondaryAccent;
    this.tertiaryAccent.value = preset.theme.tertiaryAccent;
    this.syncColorPickers();
  }

  private syncThemePresetSelection(): void {
    this.themePreset.value = matchingPresetId(this.currentAppThemeDraft());
  }

  private populateGeneral(settings: DesktopSettings): void {
    this.confirmBeforeClosingTab.checked = settings.persistence.confirmBeforeClosingTab;
    this.confirmBeforeClosingTerminal.checked = settings.persistence.confirmBeforeClosingTerminal;
    this.fontFamily.value = settings.terminal.fontFamily;
    this.syncFontFamilySelection();
    this.ensureFontSizeOption(settings.terminal.fontSize);
    this.fontSize.value = String(settings.terminal.fontSize);
    this.cursorBlink.checked = settings.terminal.cursorBlink;
    this.background.value = settings.terminal.theme.background;
    this.foreground.value = settings.terminal.theme.foreground;
    this.sidebarBackground.value = settings.appTheme.sidebarBackground;
    this.appBackground.value = settings.appTheme.appBackground;
    this.terminalBackground.value = settings.appTheme.terminalBackground;
    this.textColor.value = settings.appTheme.textColor;
    this.accent.value = settings.appTheme.accent;
    this.secondaryAccent.value = settings.appTheme.secondaryAccent;
    this.tertiaryAccent.value = settings.appTheme.tertiaryAccent;
    this.syncColorPickers();
    this.syncThemePresetSelection();
  }

  private currentSettings(): DesktopSettings {
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error('Settings have not finished loading');
    const fontSize = Number.parseInt(this.fontSize.value, 10);
    return {
      hub: { endpoint: snapshot.settings.hub.endpoint },
      sessionPrefix: snapshot.settings.sessionPrefix,
      persistence: {
        onWindowClose: snapshot.settings.persistence.onWindowClose,
        confirmBeforeClosingTab: this.confirmBeforeClosingTab.checked,
        confirmBeforeClosingTerminal: this.confirmBeforeClosingTerminal.checked,
      },
      terminal: {
        ...cloneSettings(snapshot.settings).terminal,
        fontFamily: this.fontFamilyChoice.value === 'custom' ? this.fontFamily.value : this.fontFamilyChoice.value,
        fontSize,
        cursorBlink: this.cursorBlink.checked,
        theme: {
          ...snapshot.settings.terminal.theme,
          background: this.background.value,
          foreground: this.foreground.value,
        },
      },
      appTheme: this.currentAppThemeDraft(),
      keybindings: { overrides: structuredClone(this.draftOverrides) },
    };
  }

  private setBusy(busy: boolean): void {
    this.saving = busy && this.snapshot !== null;
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      'input, button, select',
    )) {
      control.disabled = busy;
    }
  }

  private clearError(): void {
    this.errorElement.hidden = true;
    this.errorElement.textContent = '';
  }

  private showError(message: string): void {
    this.errorElement.textContent = message;
    this.errorElement.hidden = false;
  }

  private effectiveBindings(): Keybinding[] {
    return mergeKeybindings(this.getDefaults(), this.draftOverrides);
  }

  private renderKeybindings(): void {
    const defaults = this.getDefaults();
    const effective = this.effectiveBindings();
    const recordingSignature = this.recordingCommand
      ? commandInvocationSignature(this.recordingCommand)
      : null;
    this.keybindingList.replaceChildren();
    this.getEntries().forEach((entry, index) => {
      const signature = commandInvocationSignature(entry.invocation);
      const current = bindingForCommand(effective, entry.invocation);
      const defaultBinding = bindingForCommand(defaults, entry.invocation);
      const row = this.document.createElement('div');
      row.className = 'keybinding-row';
      row.dataset.command = signature;
      row.dataset.commandId = entry.invocation.id;
      row.dataset.testid = `keybinding-row-${index}`;

      const title = this.document.createElement('span');
      title.className = 'keybinding-title';
      title.textContent = entry.title;
      const currentText = this.document.createElement('span');
      currentText.className = 'keybinding-current';
      currentText.textContent = `Current: ${current ? formatKeybinding(current) : 'Unbound'}`;
      const defaultText = this.document.createElement('span');
      defaultText.className = 'keybinding-default';
      defaultText.textContent = `Default: ${defaultBinding ? formatKeybinding(defaultBinding) : 'Unbound'}`;
      const actions = this.document.createElement('span');
      actions.className = 'keybinding-actions';
      const record = button(
        this.document,
        recordingSignature === signature ? 'Press shortcut…' : 'Record',
        `keybinding-record-${index}`,
      );
      record.dataset.recording = String(recordingSignature === signature);
      record.setAttribute('aria-label', `Record shortcut for ${entry.title}`);
      record.addEventListener('click', () => {
        this.recordingCommand = structuredClone(entry.invocation);
        this.statusElement.textContent = `Recording ${entry.title}. Press a shortcut; Escape cancels.`;
        this.clearError();
        this.renderKeybindings();
        const activeRecord = this.keybindingList.querySelector<HTMLButtonElement>(
          `[data-testid="keybinding-record-${index}"]`,
        );
        activeRecord?.focus({ preventScroll: true });
      });
      const unbind = button(this.document, 'Unbind', `keybinding-unbind-${index}`);
      unbind.setAttribute('aria-label', `Unbind ${entry.title}`);
      unbind.addEventListener('click', () => this.updateOverride(entry.invocation, null));
      const reset = button(this.document, 'Reset', `keybinding-reset-${index}`);
      reset.setAttribute('aria-label', `Reset ${entry.title} to its default shortcut`);
      reset.addEventListener('click', () => this.updateOverride(entry.invocation, undefined));
      actions.append(record, unbind, reset);
      row.append(title, currentText, defaultText, actions);
      this.keybindingList.append(row);
    });
  }

  private proposedOverrides(
    command: CommandInvocation,
    binding: KeyCombination | null | undefined,
  ): KeybindingOverride[] {
    const signature = commandInvocationSignature(command);
    const remaining = this.draftOverrides.filter(
      (override) => commandInvocationSignature(override.command) !== signature,
    );
    if (binding !== undefined) {
      remaining.push({ command: structuredClone(command), binding: binding ? { ...binding } : null });
    }
    return remaining;
  }

  private updateOverride(
    command: CommandInvocation,
    binding: KeyCombination | null | undefined,
  ): boolean {
    const proposed = this.proposedOverrides(command, binding);
    try {
      const validated = validateKeybindingSettings(
        { overrides: proposed },
        this.getDefaults(),
        this.getAllowedInvocations(),
      );
      this.draftOverrides = validated.overrides;
      this.recordingCommand = null;
      this.clearError();
      this.statusElement.textContent = binding === undefined
        ? 'Shortcut reset to its default.'
        : binding === null ? 'Shortcut unbound.' : 'Shortcut recorded. Save to apply it.';
      this.renderKeybindings();
      return true;
    } catch (error) {
      this.showError(`Shortcut is invalid: ${errorMessage(error)}`);
      return false;
    }
  }

  private recordKey(event: KeyboardEvent): void {
    const command = this.recordingCommand;
    if (!command) return;
    if (event.getModifierState('AltGraph')) {
      this.showError('AltGraph input cannot be used as a global shortcut.');
      return;
    }
    this.updateOverride(command, {
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  private trapTab(event: KeyboardEvent): void {
    event.preventDefault();
    const focusable = [...this.form.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    )].filter((element) => !element.closest('[hidden]'));
    if (focusable.length === 0) return;
    const current = focusable.indexOf(this.document.activeElement as HTMLElement);
    const direction = event.shiftKey ? -1 : 1;
    const next = current < 0
      ? (direction === 1 ? 0 : focusable.length - 1)
      : (current + direction + focusable.length) % focusable.length;
    focusable[next]?.focus({ preventScroll: true });
  }

  private async performSave(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || this.saving) return;
    this.clearError();
    if (!this.form.checkValidity()) {
      this.form.reportValidity();
      this.showError('Correct the highlighted General settings before saving.');
      return;
    }
    try {
      validateKeybindingSettings(
        { overrides: this.draftOverrides },
        this.getDefaults(),
        this.getAllowedInvocations(),
      );
    } catch (error) {
      this.showError(`Shortcuts cannot be saved: ${errorMessage(error)}`);
      return;
    }

    this.setBusy(true);
    this.statusElement.textContent = 'Saving…';
    try {
      const saved = await this.saveSettings({
        revision: snapshot.revision,
        settings: this.currentSettings(),
      });
      this.snapshot = { revision: saved.revision, settings: cloneSettings(saved.settings) };
      this.draftOverrides = structuredClone(saved.settings.keybindings.overrides);
      this.onSaved(saved);
      this.saving = false;
      this.statusElement.textContent = 'Saved.';
      this.close();
    } catch (error) {
      this.showError(`Settings could not be saved: ${errorMessage(error)}`);
      this.statusElement.textContent = '';
      this.setBusy(false);
      this.syncFontFamilySelection();
    }
  }
}
