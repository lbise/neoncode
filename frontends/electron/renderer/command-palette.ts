import type {
  CommandCategory,
  CommandDispatchResult,
  CommandInvocation,
} from '../shared/command-catalog';
import type { CommandRegistry } from './command-registry';

export interface PaletteCommandEntry {
  invocation: CommandInvocation;
  title: string;
  category: CommandCategory;
  searchTerms: string[];
  shortcut: string | null;
}

interface PaletteViewEntry extends PaletteCommandEntry {
  enabled: boolean;
  disabledReason: string | null;
}

interface CommandPaletteOptions {
  documentRef: Document;
  registry: CommandRegistry;
  getEntries: () => PaletteCommandEntry[];
  dispatch: (invocation: CommandInvocation) => Promise<CommandDispatchResult>;
  restoreActivePaneFocus: () => void;
}

function requiredElement<T extends HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing command palette element: #${id}`);
  return element as T;
}

function normalizedQueryTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

export function filterPaletteEntries(
  entries: readonly PaletteCommandEntry[],
  query: string,
): PaletteCommandEntry[] {
  const queryTerms = normalizedQueryTerms(query);
  if (queryTerms.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = [entry.title, entry.category, ...entry.searchTerms].join(' ').toLocaleLowerCase();
    return queryTerms.every((term) => haystack.includes(term));
  });
}

export function nextPaletteIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

export class CommandPalette {
  private readonly document: Document;
  private readonly registry: CommandRegistry;
  private readonly getEntries: () => PaletteCommandEntry[];
  private readonly dispatch: (invocation: CommandInvocation) => Promise<CommandDispatchResult>;
  private readonly restoreActivePaneFocus: () => void;
  private readonly overlay: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly triggerButton: HTMLButtonElement;
  private entries: PaletteViewEntry[] = [];
  private selectedIndex = -1;
  private previousFocus: HTMLElement | null = null;
  private executing = false;

  constructor({
    documentRef,
    registry,
    getEntries,
    dispatch,
    restoreActivePaneFocus,
  }: CommandPaletteOptions) {
    this.document = documentRef;
    this.registry = registry;
    this.getEntries = getEntries;
    this.dispatch = dispatch;
    this.restoreActivePaneFocus = restoreActivePaneFocus;
    this.overlay = requiredElement(documentRef, 'command-palette-overlay');
    this.input = requiredElement<HTMLInputElement>(documentRef, 'command-palette-input');
    this.results = requiredElement(documentRef, 'command-palette-results');
    this.emptyState = requiredElement(documentRef, 'command-palette-empty');
    this.closeButton = requiredElement<HTMLButtonElement>(documentRef, 'command-palette-close');
    this.triggerButton = requiredElement<HTMLButtonElement>(documentRef, 'commands-button');

    this.input.addEventListener('input', () => this.refresh());
    this.closeButton.addEventListener('click', () => {
      void this.dispatch({ id: 'palette.close' });
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    const active = this.document.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    this.executing = false;
    this.input.value = '';
    this.overlay.hidden = false;
    this.triggerButton.setAttribute('aria-expanded', 'true');
    this.refresh();
    this.input.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.overlay.hidden = true;
    this.triggerButton.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    const previousFocus = this.previousFocus;
    this.previousFocus = null;
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true });
    } else {
      this.restoreActivePaneFocus();
    }
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === 'Escape') {
      this.consume(event);
      if (!event.repeat) void this.dispatch({ id: 'palette.close' });
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      this.consume(event);
      if (!event.repeat) {
        this.selectedIndex = nextPaletteIndex(
          this.selectedIndex,
          this.entries.length,
          event.key === 'ArrowDown' ? 1 : -1,
        );
        this.renderSelection();
      }
      this.input.focus({ preventScroll: true });
      return true;
    }
    if (event.key === 'Enter' && event.target !== this.closeButton) {
      this.consume(event);
      if (!event.repeat) void this.executeSelected();
      return true;
    }
    if (event.key === 'Tab') {
      return this.trapTab(event);
    }
    return false;
  }

  private consume(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private trapTab(event: KeyboardEvent): boolean {
    const active = this.document.activeElement;
    if (active === this.input) {
      this.consume(event);
      this.closeButton.focus({ preventScroll: true });
      return true;
    }
    if (active === this.closeButton) {
      this.consume(event);
      this.input.focus({ preventScroll: true });
      return true;
    }
    this.consume(event);
    this.input.focus({ preventScroll: true });
    return true;
  }

  private refresh(): void {
    this.entries = filterPaletteEntries(this.getEntries(), this.input.value).map((entry) => {
      const description = this.registry.describe(entry.invocation);
      return {
        ...entry,
        enabled: description.enabled,
        disabledReason: description.disabledReason,
      };
    });
    const firstEnabled = this.entries.findIndex((entry) => entry.enabled);
    this.selectedIndex = firstEnabled >= 0 ? firstEnabled : (this.entries.length > 0 ? 0 : -1);
    this.render();
  }

  private render(): void {
    this.results.replaceChildren();
    this.emptyState.hidden = this.entries.length > 0;
    this.entries.forEach((entry, index) => {
      const option = this.document.createElement('button');
      option.type = 'button';
      option.id = `command-palette-option-${index}`;
      option.className = 'command-palette-option';
      option.dataset.testid = `command-palette-option-${index}`;
      option.dataset.commandId = entry.invocation.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === this.selectedIndex));
      option.setAttribute('aria-disabled', String(!entry.enabled));
      option.tabIndex = -1;
      option.disabled = !entry.enabled;

      const identity = this.document.createElement('span');
      identity.className = 'command-palette-option-identity';
      const title = this.document.createElement('span');
      title.className = 'command-palette-option-title';
      title.textContent = entry.title;
      const category = this.document.createElement('span');
      category.className = 'command-palette-option-category';
      category.textContent = entry.category;
      identity.append(title, category);

      const detail = this.document.createElement('span');
      detail.className = 'command-palette-option-detail';
      if (entry.enabled) {
        detail.textContent = entry.shortcut ?? '';
        if (entry.shortcut) detail.classList.add('command-palette-shortcut');
      } else {
        detail.textContent = [entry.shortcut, entry.disabledReason ?? 'Unavailable'].filter(Boolean).join(' · ');
        detail.classList.add('command-palette-disabled-reason');
      }
      option.append(identity, detail);
      option.addEventListener('pointermove', () => {
        this.selectedIndex = index;
        this.renderSelection();
      });
      option.addEventListener('click', () => {
        this.selectedIndex = index;
        void this.executeSelected();
      });
      this.results.append(option);
    });
    this.renderSelection();
  }

  private renderSelection(): void {
    const options = this.results.querySelectorAll<HTMLElement>('.command-palette-option');
    options.forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === this.selectedIndex));
    });
    const selected = options.item(this.selectedIndex);
    if (selected) {
      this.input.setAttribute('aria-activedescendant', selected.id);
      selected.scrollIntoView({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  private async executeSelected(): Promise<void> {
    if (this.executing) return;
    const entry = this.entries[this.selectedIndex];
    if (!entry?.enabled) return;
    this.executing = true;
    if (entry.invocation.id === 'palette.close') {
      await this.dispatch(entry.invocation);
      return;
    }
    const closeResult = await this.dispatch({ id: 'palette.close' });
    if (closeResult.status === 'completed') await this.dispatch(entry.invocation);
  }
}
