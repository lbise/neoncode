import type {
  CommandDispatchResult,
  TabCloseCommandArgs,
  TabRenameCommandArgs,
} from '../shared/command-catalog';

interface ActiveTabTarget {
  workspaceId: string;
  tabId: string;
  title: string;
}

interface TabDialogOptions {
  documentRef: Document;
  getActiveTab: () => ActiveTabTarget | null;
  dispatchRename: (args: TabRenameCommandArgs) => Promise<CommandDispatchResult>;
  dispatchClose: (args: TabCloseCommandArgs) => Promise<CommandDispatchResult>;
  restoreActivePaneFocus: () => void;
}

type TabDialogMode = 'rename' | 'close';

function requiredElement<T extends HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing tab dialog element: #${id}`);
  return element as T;
}

export class TabDialog {
  readonly overlay: HTMLElement;
  readonly dialog: HTMLFormElement;
  readonly title: HTMLElement;
  readonly description: HTMLElement;
  readonly nameField: HTMLElement;
  readonly nameInput: HTMLInputElement;
  readonly error: HTMLElement;
  readonly status: HTMLElement;
  readonly submitButton: HTMLButtonElement;
  private readonly getActiveTab: () => ActiveTabTarget | null;
  private readonly dispatchRename: TabDialogOptions['dispatchRename'];
  private readonly dispatchClose: TabDialogOptions['dispatchClose'];
  private readonly restoreActivePaneFocus: () => void;
  private mode: TabDialogMode = 'rename';
  private target: ActiveTabTarget | null = null;
  private pending = false;

  constructor({
    documentRef,
    getActiveTab,
    dispatchRename,
    dispatchClose,
    restoreActivePaneFocus,
  }: TabDialogOptions) {
    this.overlay = requiredElement(documentRef, 'tab-dialog-overlay');
    this.dialog = requiredElement<HTMLFormElement>(documentRef, 'tab-dialog');
    this.title = requiredElement(documentRef, 'tab-dialog-title');
    this.description = requiredElement(documentRef, 'tab-dialog-description');
    this.nameField = requiredElement(documentRef, 'tab-title-field');
    this.nameInput = requiredElement<HTMLInputElement>(documentRef, 'tab-title');
    this.error = requiredElement(documentRef, 'tab-dialog-error');
    this.status = requiredElement(documentRef, 'tab-dialog-status');
    this.submitButton = requiredElement<HTMLButtonElement>(documentRef, 'tab-dialog-submit');
    this.getActiveTab = getActiveTab;
    this.dispatchRename = dispatchRename;
    this.dispatchClose = dispatchClose;
    this.restoreActivePaneFocus = restoreActivePaneFocus;

    requiredElement(documentRef, 'tab-dialog-close').addEventListener('click', () => this.close());
    requiredElement(documentRef, 'tab-dialog-cancel').addEventListener('click', () => this.close());
    this.overlay.addEventListener('pointerdown', (event) => {
      if (event.target === this.overlay) this.close();
    });
    this.dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(mode: TabDialogMode): void {
    const target = this.getActiveTab();
    if (!target) throw new Error('no active tab');
    this.mode = mode;
    this.target = target;
    this.error.hidden = true;
    this.error.textContent = '';
    this.status.textContent = '';
    this.pending = false;
    this.nameField.hidden = mode !== 'rename';
    this.title.textContent = mode === 'rename' ? 'Rename tab' : 'Close tab';
    this.description.textContent = mode === 'rename'
      ? `Change the title of ${target.title}.`
      : `Close ${target.title} and kill its terminal session. At least one tab will remain.`;
    this.submitButton.textContent = mode === 'rename' ? 'Rename' : 'Close tab';
    this.nameInput.value = target.title;
    this.overlay.hidden = false;
    queueMicrotask(() => {
      if (mode === 'rename') this.nameInput.select();
      else this.submitButton.focus({ preventScroll: true });
    });
  }

  close(): void {
    if (!this.isOpen || this.pending) return;
    this.overlay.hidden = true;
    this.target = null;
    this.restoreActivePaneFocus();
  }

  handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.close();
      return;
    }
    if (event.key === 'Tab') this.trapFocus(event);
  }

  private trapFocus(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    const focusable = [...this.dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)',
    )].filter((element) => !element.closest('[hidden]'));
    if (focusable.length === 0) return;
    const current = focusable.indexOf(this.dialog.ownerDocument.activeElement as HTMLElement);
    const direction = event.shiftKey ? -1 : 1;
    const next = current < 0
      ? (direction === 1 ? 0 : focusable.length - 1)
      : (current + direction + focusable.length) % focusable.length;
    focusable[next]?.focus({ preventScroll: true });
  }

  private async submit(): Promise<void> {
    const target = this.target;
    if (!target || this.pending) return;
    this.pending = true;
    this.submitButton.disabled = true;
    this.error.hidden = true;
    this.status.textContent = this.mode === 'rename' ? 'Renaming…' : 'Closing…';
    try {
      const result = this.mode === 'rename'
        ? await this.dispatchRename({
          workspaceId: target.workspaceId,
          tabId: target.tabId,
          title: this.nameInput.value.trim(),
        })
        : await this.dispatchClose({
          workspaceId: target.workspaceId,
          tabId: target.tabId,
        });
      if (result.status === 'completed') {
        this.pending = false;
        this.overlay.hidden = true;
        this.target = null;
        this.restoreActivePaneFocus();
        return;
      }
      this.error.textContent = result.status === 'disabled' ? result.reason : result.message;
      this.error.hidden = false;
    } finally {
      this.pending = false;
      this.submitButton.disabled = false;
      this.status.textContent = '';
    }
  }
}
