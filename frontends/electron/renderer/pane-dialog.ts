import type {
  CommandDispatchResult,
  PaneCloseCommandArgs,
} from '../shared/command-catalog';

interface ActivePaneTarget {
  workspaceId: string;
  paneId: string;
  title: string;
}

interface PaneDialogOptions {
  documentRef: Document;
  getActivePane: () => ActivePaneTarget | null;
  dispatchClose: (args: PaneCloseCommandArgs) => Promise<CommandDispatchResult>;
  restoreActivePaneFocus: () => void;
}

function requiredElement<T extends HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing pane dialog element: #${id}`);
  return element as T;
}

export class PaneDialog {
  readonly overlay: HTMLElement;
  readonly dialog: HTMLFormElement;
  readonly description: HTMLElement;
  readonly error: HTMLElement;
  readonly status: HTMLElement;
  readonly submitButton: HTMLButtonElement;
  private readonly getActivePane: () => ActivePaneTarget | null;
  private readonly dispatchClose: PaneDialogOptions['dispatchClose'];
  private readonly restoreActivePaneFocus: () => void;
  private target: ActivePaneTarget | null = null;
  private pending = false;

  constructor({
    documentRef,
    getActivePane,
    dispatchClose,
    restoreActivePaneFocus,
  }: PaneDialogOptions) {
    this.overlay = requiredElement(documentRef, 'pane-dialog-overlay');
    this.dialog = requiredElement<HTMLFormElement>(documentRef, 'pane-dialog');
    this.description = requiredElement(documentRef, 'pane-dialog-description');
    this.error = requiredElement(documentRef, 'pane-dialog-error');
    this.status = requiredElement(documentRef, 'pane-dialog-status');
    this.submitButton = requiredElement<HTMLButtonElement>(documentRef, 'pane-dialog-submit');
    this.getActivePane = getActivePane;
    this.dispatchClose = dispatchClose;
    this.restoreActivePaneFocus = restoreActivePaneFocus;

    requiredElement(documentRef, 'pane-dialog-close').addEventListener('click', () => this.close());
    requiredElement(documentRef, 'pane-dialog-cancel').addEventListener('click', () => this.close());
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

  open(): void {
    const target = this.getActivePane();
    if (!target) throw new Error('no active pane');
    this.target = target;
    this.pending = false;
    this.submitButton.disabled = false;
    this.error.hidden = true;
    this.error.textContent = '';
    this.status.textContent = '';
    this.description.textContent = `Close ${target.title}. Its tab and sibling panes will remain.`;
    const detach = this.dialog.querySelector<HTMLInputElement>(
      'input[name="pane-disposition"][value="detach"]',
    );
    if (detach) detach.checked = true;
    this.overlay.hidden = false;
    queueMicrotask(() => detach?.focus());
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
    )];
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
    this.status.textContent = 'Closing…';
    try {
      const result = await this.dispatchClose({
        workspaceId: target.workspaceId,
        paneId: target.paneId,
        disposition: this.dialog.querySelector<HTMLInputElement>(
          'input[name="pane-disposition"]:checked',
        )?.value === 'kill' ? 'kill' : 'detach',
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
