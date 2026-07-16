import type { DesktopLaunchProfile } from '../shared/types';
import type {
  CommandDispatchResult,
  WorkspaceCreateCommandArgs,
  WorkspaceDeleteCommandArgs,
  WorkspaceRenameCommandArgs,
} from '../shared/command-catalog';

export type WorkspaceDialogMode = 'create' | 'rename' | 'delete';

interface WorkspaceDialogTarget {
  id: string;
  name: string;
}

interface WorkspaceDialogOptions {
  documentRef: Document;
  getLaunchProfiles: () => Readonly<Record<string, DesktopLaunchProfile>>;
  getActiveWorkspace: () => WorkspaceDialogTarget | null;
  dispatchCreate: (args: WorkspaceCreateCommandArgs) => Promise<CommandDispatchResult>;
  dispatchRename: (args: WorkspaceRenameCommandArgs) => Promise<CommandDispatchResult>;
  dispatchDelete: (args: WorkspaceDeleteCommandArgs) => Promise<CommandDispatchResult>;
  restoreActivePaneFocus: () => void;
}

function requiredElement<T extends HTMLElement>(documentRef: Document, id: string): T {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Missing workspace dialog element: #${id}`);
  return element as T;
}

function randomIdentifier(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${suffix}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export class WorkspaceDialog {
  private readonly document: Document;
  private readonly getLaunchProfiles: WorkspaceDialogOptions['getLaunchProfiles'];
  private readonly getActiveWorkspace: WorkspaceDialogOptions['getActiveWorkspace'];
  private readonly dispatchCreate: WorkspaceDialogOptions['dispatchCreate'];
  private readonly dispatchRename: WorkspaceDialogOptions['dispatchRename'];
  private readonly dispatchDelete: WorkspaceDialogOptions['dispatchDelete'];
  private readonly restoreActivePaneFocus: () => void;
  private readonly overlay: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly nameField: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly pathField: HTMLElement;
  private readonly pathInput: HTMLInputElement;
  private readonly profileField: HTMLElement;
  private readonly profileSelect: HTMLSelectElement;
  private readonly dispositionField: HTMLFieldSetElement;
  private readonly errorElement: HTMLElement;
  private readonly statusElement: HTMLElement;
  private mode: WorkspaceDialogMode = 'create';
  private target: WorkspaceDialogTarget | null = null;
  private previousFocus: HTMLElement | null = null;
  private saving = false;

  constructor({
    documentRef,
    getLaunchProfiles,
    getActiveWorkspace,
    dispatchCreate,
    dispatchRename,
    dispatchDelete,
    restoreActivePaneFocus,
  }: WorkspaceDialogOptions) {
    this.document = documentRef;
    this.getLaunchProfiles = getLaunchProfiles;
    this.getActiveWorkspace = getActiveWorkspace;
    this.dispatchCreate = dispatchCreate;
    this.dispatchRename = dispatchRename;
    this.dispatchDelete = dispatchDelete;
    this.restoreActivePaneFocus = restoreActivePaneFocus;
    this.overlay = requiredElement(documentRef, 'workspace-dialog-overlay');
    this.form = requiredElement<HTMLFormElement>(documentRef, 'workspace-dialog');
    this.title = requiredElement(documentRef, 'workspace-dialog-title');
    this.description = requiredElement(documentRef, 'workspace-dialog-description');
    this.closeButton = requiredElement<HTMLButtonElement>(documentRef, 'workspace-dialog-close');
    this.cancelButton = requiredElement<HTMLButtonElement>(documentRef, 'workspace-dialog-cancel');
    this.submitButton = requiredElement<HTMLButtonElement>(documentRef, 'workspace-dialog-submit');
    this.nameField = requiredElement(documentRef, 'workspace-name-field');
    this.nameInput = requiredElement<HTMLInputElement>(documentRef, 'workspace-name');
    this.pathField = requiredElement(documentRef, 'workspace-path-field');
    this.pathInput = requiredElement<HTMLInputElement>(documentRef, 'workspace-path');
    this.profileField = requiredElement(documentRef, 'workspace-profile-field');
    this.profileSelect = requiredElement<HTMLSelectElement>(documentRef, 'workspace-profile');
    this.dispositionField = requiredElement<HTMLFieldSetElement>(documentRef, 'workspace-disposition-field');
    this.errorElement = requiredElement(documentRef, 'workspace-dialog-error');
    this.statusElement = requiredElement(documentRef, 'workspace-dialog-status');

    this.closeButton.addEventListener('click', () => this.close());
    this.cancelButton.addEventListener('click', () => this.close());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(mode: WorkspaceDialogMode): void {
    if (this.isOpen) return;
    const target = mode === 'create' ? null : this.getActiveWorkspace();
    if (mode !== 'create' && !target) throw new Error('no active workspace');
    const active = this.document.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    this.mode = mode;
    this.target = target;
    this.setBusy(false);
    this.errorElement.hidden = true;
    this.errorElement.textContent = '';
    this.statusElement.textContent = '';
    this.form.reset();
    this.populateProfiles();

    this.nameField.hidden = mode === 'delete';
    this.pathField.hidden = mode !== 'create';
    this.profileField.hidden = mode !== 'create';
    this.dispositionField.hidden = mode !== 'delete';
    this.nameInput.required = mode !== 'delete';
    this.profileSelect.required = mode === 'create';

    if (mode === 'create') {
      this.title.textContent = 'Create Workspace';
      this.description.textContent = 'Start a durable workspace with one Shell session.';
      this.nameInput.value = '';
      this.pathInput.value = '';
      this.submitButton.textContent = 'Create';
    } else if (mode === 'rename') {
      this.title.textContent = 'Rename Workspace';
      this.description.textContent = `Rename ${target?.name ?? 'the current workspace'}.`;
      this.nameInput.value = target?.name ?? '';
      this.submitButton.textContent = 'Rename';
    } else {
      this.title.textContent = 'Delete Workspace';
      this.description.textContent = `Remove ${target?.name ?? 'the current workspace'} from NeonCode. Choose what happens to its hub sessions.`;
      this.submitButton.textContent = 'Delete';
    }

    this.overlay.hidden = false;
    (mode === 'delete' ? this.dispositionField.querySelector<HTMLInputElement>('input:checked') : this.nameInput)
      ?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen || this.saving) return;
    this.overlay.hidden = true;
    const previous = this.previousFocus;
    this.previousFocus = null;
    this.target = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    else this.restoreActivePaneFocus();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.close();
      return true;
    }
    if (event.key === 'Tab') {
      this.trapFocus(event);
      return true;
    }
    return false;
  }

  private populateProfiles(): void {
    this.profileSelect.replaceChildren();
    for (const [profileId, profile] of Object.entries(this.getLaunchProfiles())) {
      const option = this.document.createElement('option');
      option.value = profileId;
      option.textContent = `${profileId} — ${profile.command}${profile.cwd ? ` · ${profile.cwd}` : ''}`;
      this.profileSelect.append(option);
    }
  }

  private setBusy(busy: boolean): void {
    this.saving = busy;
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      'input, select, button',
    )) control.disabled = busy;
  }

  private showError(message: string): void {
    this.errorElement.textContent = message;
    this.errorElement.hidden = false;
  }

  private validateName(): string | null {
    const name = this.nameInput.value.trim();
    if (!name || byteLength(name) > 64 || hasControl(name)) {
      this.showError('Name must contain 1–64 UTF-8 bytes and no control characters.');
      this.nameInput.focus({ preventScroll: true });
      return null;
    }
    return name;
  }

  private validatePath(): string | null | undefined {
    const path = this.pathInput.value;
    if (path.length === 0) return null;
    if (byteLength(path) > 4096 || hasControl(path)) {
      this.showError('Path must contain at most 4096 UTF-8 bytes and no control characters.');
      this.pathInput.focus({ preventScroll: true });
      return undefined;
    }
    return path;
  }

  private async submit(): Promise<void> {
    if (this.saving) return;
    this.errorElement.hidden = true;
    let operation: Promise<CommandDispatchResult>;
    if (this.mode === 'create') {
      const name = this.validateName();
      const path = this.validatePath();
      if (name === null || path === undefined) return;
      const defaultLaunchProfile = this.profileSelect.value;
      if (!defaultLaunchProfile) {
        this.showError('Select a configured launch profile.');
        return;
      }
      const sessionId = randomIdentifier('session');
      operation = this.dispatchCreate({
        workspaceId: randomIdentifier('workspace'),
        name,
        path,
        defaultLaunchProfile,
        sessionId,
        title: 'Shell',
      });
    } else if (this.mode === 'rename') {
      const name = this.validateName();
      if (name === null || !this.target) return;
      operation = this.dispatchRename({ workspaceId: this.target.id, name });
    } else {
      if (!this.target) return;
      const checked = this.form.querySelector<HTMLInputElement>('input[name="workspace-disposition"]:checked');
      operation = this.dispatchDelete({
        workspaceId: this.target.id,
        disposition: checked?.value === 'kill' ? 'kill' : 'detach',
      });
    }

    this.setBusy(true);
    this.statusElement.textContent = 'Saving…';
    try {
      const result = await operation;
      if (result.status === 'completed') {
        this.saving = false;
        this.overlay.hidden = true;
        this.previousFocus = null;
        this.target = null;
        this.restoreActivePaneFocus();
        return;
      }
      this.showError(result.status === 'disabled' ? result.reason : result.message);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
    this.statusElement.textContent = '';
    this.setBusy(false);
  }

  private trapFocus(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
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
}
