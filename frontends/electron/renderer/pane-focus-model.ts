export interface WorkspacePaneOrder {
  workspaceId: string;
  paneIds: readonly string[];
}

function validatePaneOrder(workspaceId: string, paneIds: readonly string[]): string[] {
  const ordered = [...paneIds];
  if (new Set(ordered).size !== ordered.length) {
    throw new Error(`duplicate pane id in workspace: ${workspaceId}`);
  }
  return ordered;
}

export class PaneFocusModel {
  private readonly paneIdsByWorkspace = new Map<string, string[]>();
  private readonly rememberedPaneIds = new Map<string, string>();
  activeWorkspaceId: string | null = null;
  activePaneId: string | null = null;

  constructor(workspaces: readonly WorkspacePaneOrder[] = []) {
    for (const workspace of workspaces) {
      if (this.paneIdsByWorkspace.has(workspace.workspaceId)) {
        throw new Error(`duplicate workspace id: ${workspace.workspaceId}`);
      }
      this.paneIdsByWorkspace.set(
        workspace.workspaceId,
        validatePaneOrder(workspace.workspaceId, workspace.paneIds),
      );
    }
  }

  paneIds(workspaceId: string): readonly string[] {
    const paneIds = this.paneIdsByWorkspace.get(workspaceId);
    if (!paneIds) throw new Error(`unknown workspace: ${workspaceId}`);
    return [...paneIds];
  }

  addWorkspace(workspaceId: string, paneIds: readonly string[]): void {
    if (this.paneIdsByWorkspace.has(workspaceId)) {
      throw new Error(`duplicate workspace id: ${workspaceId}`);
    }
    this.paneIdsByWorkspace.set(workspaceId, validatePaneOrder(workspaceId, paneIds));
  }

  removeWorkspace(workspaceId: string, activateWorkspaceId?: string): void {
    if (!this.paneIdsByWorkspace.delete(workspaceId)) {
      throw new Error(`unknown workspace: ${workspaceId}`);
    }
    this.rememberedPaneIds.delete(workspaceId);
    if (this.activeWorkspaceId !== workspaceId) return;
    this.activeWorkspaceId = null;
    this.activePaneId = null;
    if (activateWorkspaceId !== undefined) this.activateWorkspace(activateWorkspaceId);
  }

  setPaneOrder(workspaceId: string, paneIds: readonly string[]): string | null {
    if (!this.paneIdsByWorkspace.has(workspaceId)) {
      throw new Error(`unknown workspace: ${workspaceId}`);
    }
    const ordered = validatePaneOrder(workspaceId, paneIds);
    this.paneIdsByWorkspace.set(workspaceId, ordered);

    const remembered = this.rememberedPaneIds.get(workspaceId);
    if (!remembered || !ordered.includes(remembered)) {
      const fallback = ordered[0] ?? null;
      if (fallback) this.rememberedPaneIds.set(workspaceId, fallback);
      else this.rememberedPaneIds.delete(workspaceId);
    }

    if (this.activeWorkspaceId === workspaceId) {
      const activeStillExists = this.activePaneId !== null && ordered.includes(this.activePaneId);
      if (!activeStillExists) {
        this.activePaneId = this.rememberedPaneIds.get(workspaceId) ?? ordered[0] ?? null;
      }
      if (this.activePaneId) this.rememberedPaneIds.set(workspaceId, this.activePaneId);
    }
    return this.activeWorkspaceId === workspaceId ? this.activePaneId : null;
  }

  updateWorkspace(workspaceId: string, paneIds: readonly string[]): string | null {
    return this.setPaneOrder(workspaceId, paneIds);
  }

  activateWorkspace(workspaceId: string): string | null {
    const paneIds = this.paneIdsByWorkspace.get(workspaceId);
    if (!paneIds) throw new Error(`unknown workspace: ${workspaceId}`);
    this.activeWorkspaceId = workspaceId;
    const remembered = this.rememberedPaneIds.get(workspaceId);
    this.activePaneId = remembered && paneIds.includes(remembered)
      ? remembered
      : paneIds[0] ?? null;
    if (this.activePaneId) this.rememberedPaneIds.set(workspaceId, this.activePaneId);
    return this.activePaneId;
  }

  focusPane(paneId: string): string {
    const workspaceId = this.activeWorkspaceId;
    if (!workspaceId) throw new Error('no active workspace');
    const paneIds = this.paneIdsByWorkspace.get(workspaceId);
    if (!paneIds?.includes(paneId)) throw new Error(`unknown pane in active workspace: ${paneId}`);
    this.activePaneId = paneId;
    this.rememberedPaneIds.set(workspaceId, paneId);
    return paneId;
  }

  nextPane(): string | null {
    return this.move(1);
  }

  previousPane(): string | null {
    return this.move(-1);
  }

  private move(direction: 1 | -1): string | null {
    const workspaceId = this.activeWorkspaceId;
    if (!workspaceId) return null;
    const paneIds = this.paneIdsByWorkspace.get(workspaceId) ?? [];
    if (paneIds.length === 0) {
      this.activePaneId = null;
      return null;
    }
    const currentIndex = this.activePaneId === null ? -1 : paneIds.indexOf(this.activePaneId);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + paneIds.length) % paneIds.length;
    const paneId = paneIds[nextIndex];
    if (!paneId) return null;
    this.activePaneId = paneId;
    this.rememberedPaneIds.set(workspaceId, paneId);
    return paneId;
  }
}
