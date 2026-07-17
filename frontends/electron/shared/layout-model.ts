export const MAX_WORKSPACE_TABS = 8;
export const MAX_WORKSPACE_PANES = 8;
export const MAX_LAYOUT_DEPTH = 8;
export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const MAX_LAYOUT_TITLE_BYTES = 64;

const MAX_LAYOUT_IDENTIFIER_BYTES = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type SplitDirection = 'horizontal' | 'vertical';
export type SplitPosition = 'before' | 'after';
export type SplitChildPosition = 'first' | 'second';
export type PaneResizeDirection = 'left' | 'right' | 'up' | 'down';

export interface PaneAncestorSplit {
  splitId: string;
  direction: SplitDirection;
  ratio: number;
  panePosition: SplitChildPosition;
}

export interface DirectionalSplitResize extends PaneAncestorSplit {
  delta: number;
  nextRatio: number;
}

export interface PaneLeaf {
  type: 'pane';
  paneId: string;
  sessionKey: string;
}

export interface SplitBranch {
  type: 'split';
  splitId: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneLeaf | SplitBranch;

export interface TabLayout {
  tabId: string;
  title: string;
  root: LayoutNode;
  focusedPaneId: string;
}

export interface WorkspaceLayoutState {
  activeTabId: string;
  tabs: TabLayout[];
}

export interface LayoutRemovalResult {
  state: WorkspaceLayoutState;
  removedLeaves: PaneLeaf[];
}

export interface AddTabOptions {
  tabId: string;
  title: string;
  paneId: string;
  sessionKey: string;
  index?: number;
  activate?: boolean;
}

export interface SplitPaneOptions {
  paneId: string;
  newPaneId: string;
  newSessionKey: string;
  splitId: string;
  direction: SplitDirection;
  position: SplitPosition;
}

export interface MovePaneOptions {
  paneId: string;
  targetPaneId: string;
  splitId: string;
  direction: SplitDirection;
  position: SplitPosition;
}

export interface SchemaFourLayoutSession {
  id: string;
  title: string;
}

export interface SchemaFourWorkspaceLayoutSource {
  name: string;
  layout: { columns: number };
  sessions: readonly SchemaFourLayoutSession[];
}

export interface SeedWorkspaceLayoutIds {
  tabId: string;
  splitIds: readonly string[];
  paneIds?: readonly string[];
}

export interface WorkspaceLayoutReconciliation {
  state: WorkspaceLayoutState;
  changed: boolean;
  addedSessionKeys: string[];
  removedSessionKeys: string[];
}

export class LayoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

interface ValidationContext {
  ids: Set<string>;
  sessionKeys: Set<string>;
  nodes: WeakSet<object>;
  paneCount: number;
}

interface LocatedPane {
  tabIndex: number;
  leaf: PaneLeaf;
}

interface NodeRemoval {
  root: LayoutNode | null;
  removed: PaneLeaf | null;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown, label: string): UnknownRecord {
  if (!isPlainObject(value)) throw new LayoutValidationError(`${label} must be an object`);
  return value;
}

function requireExactKeys(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LayoutValidationError(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
  return object;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string'
      || value.length === 0
      || utf8Bytes(value) > MAX_LAYOUT_IDENTIFIER_BYTES
      || !IDENTIFIER_PATTERN.test(value)) {
    throw new LayoutValidationError(
      `${label} must be a 1-${MAX_LAYOUT_IDENTIFIER_BYTES} byte layout identifier`,
    );
  }
  return value;
}

function requireTitle(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > MAX_LAYOUT_TITLE_BYTES) {
    throw new LayoutValidationError(`${label} must contain 1-${MAX_LAYOUT_TITLE_BYTES} UTF-8 bytes`);
  }
  return value;
}

function addUnique(value: string, values: Set<string>, label: string): void {
  if (values.has(value)) throw new LayoutValidationError(`duplicate ${label}: ${value}`);
  values.add(value);
}

function validateNode(
  raw: unknown,
  label: string,
  depth: number,
  context: ValidationContext,
): LayoutNode {
  if (depth > MAX_LAYOUT_DEPTH) {
    throw new LayoutValidationError(`layout depth may not exceed ${MAX_LAYOUT_DEPTH}`);
  }
  const rawObject = requireObject(raw, label);
  if (context.nodes.has(rawObject)) {
    throw new LayoutValidationError(`${label} must not reuse or cycle layout nodes`);
  }
  context.nodes.add(rawObject);

  if (rawObject.type === 'pane') {
    const pane = requireExactKeys(rawObject, ['type', 'paneId', 'sessionKey'], label);
    const paneId = requireIdentifier(pane.paneId, `${label}.paneId`);
    const sessionKey = requireIdentifier(pane.sessionKey, `${label}.sessionKey`);
    addUnique(paneId, context.ids, 'layout id');
    addUnique(sessionKey, context.sessionKeys, 'session key');
    context.paneCount += 1;
    if (context.paneCount > MAX_WORKSPACE_PANES) {
      throw new LayoutValidationError(`workspace layout may contain at most ${MAX_WORKSPACE_PANES} panes`);
    }
    return { type: 'pane', paneId, sessionKey };
  }

  if (rawObject.type === 'split') {
    const split = requireExactKeys(
      rawObject,
      ['type', 'splitId', 'direction', 'ratio', 'first', 'second'],
      label,
    );
    const splitId = requireIdentifier(split.splitId, `${label}.splitId`);
    addUnique(splitId, context.ids, 'layout id');
    if (split.direction !== 'horizontal' && split.direction !== 'vertical') {
      throw new LayoutValidationError(`${label}.direction must be horizontal or vertical`);
    }
    if (typeof split.ratio !== 'number'
        || !Number.isFinite(split.ratio)
        || split.ratio < MIN_SPLIT_RATIO
        || split.ratio > MAX_SPLIT_RATIO) {
      throw new LayoutValidationError(
        `${label}.ratio must be between ${MIN_SPLIT_RATIO} and ${MAX_SPLIT_RATIO}`,
      );
    }
    return {
      type: 'split',
      splitId,
      direction: split.direction,
      ratio: split.ratio,
      first: validateNode(split.first, `${label}.first`, depth + 1, context),
      second: validateNode(split.second, `${label}.second`, depth + 1, context),
    };
  }

  throw new LayoutValidationError(`${label}.type must be pane or split`);
}

export function validateWorkspaceLayoutState(raw: unknown): WorkspaceLayoutState {
  const document = requireExactKeys(raw, ['activeTabId', 'tabs'], 'workspace layout');
  const activeTabId = requireIdentifier(document.activeTabId, 'workspace layout.activeTabId');
  if (!Array.isArray(document.tabs)
      || document.tabs.length < 1
      || document.tabs.length > MAX_WORKSPACE_TABS) {
    throw new LayoutValidationError(
      `workspace layout.tabs must contain 1-${MAX_WORKSPACE_TABS} tabs`,
    );
  }

  const context: ValidationContext = {
    ids: new Set<string>(),
    sessionKeys: new Set<string>(),
    nodes: new WeakSet<object>(),
    paneCount: 0,
  };
  const tabs = document.tabs.map((rawTab, tabIndex): TabLayout => {
    const label = `workspace layout.tabs[${tabIndex}]`;
    const tab = requireExactKeys(rawTab, ['tabId', 'title', 'root', 'focusedPaneId'], label);
    const tabId = requireIdentifier(tab.tabId, `${label}.tabId`);
    addUnique(tabId, context.ids, 'layout id');
    const title = requireTitle(tab.title, `${label}.title`);
    const focusedPaneId = requireIdentifier(tab.focusedPaneId, `${label}.focusedPaneId`);
    const root = validateNode(tab.root, `${label}.root`, 1, context);
    if (!orderedPaneLeaves(root).some((pane) => pane.paneId === focusedPaneId)) {
      throw new LayoutValidationError(`${label}.focusedPaneId must reference a pane in the tab`);
    }
    return { tabId, title, root, focusedPaneId };
  });
  if (!tabs.some((tab) => tab.tabId === activeTabId)) {
    throw new LayoutValidationError('workspace layout.activeTabId must reference an existing tab');
  }
  return { activeTabId, tabs };
}

function cloneLeaf(leaf: PaneLeaf): PaneLeaf {
  return { type: 'pane', paneId: leaf.paneId, sessionKey: leaf.sessionKey };
}

function cloneNode(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return cloneLeaf(node);
  return {
    type: 'split',
    splitId: node.splitId,
    direction: node.direction,
    ratio: node.ratio,
    first: cloneNode(node.first),
    second: cloneNode(node.second),
  };
}

function cloneTab(tab: TabLayout): TabLayout {
  return {
    tabId: tab.tabId,
    title: tab.title,
    root: cloneNode(tab.root),
    focusedPaneId: tab.focusedPaneId,
  };
}

function finish(state: WorkspaceLayoutState): WorkspaceLayoutState {
  return validateWorkspaceLayoutState(state);
}

function checkedIndex(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new LayoutValidationError(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function findTabIndex(state: WorkspaceLayoutState, tabId: string): number {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) throw new LayoutValidationError(`unknown tab: ${tabId}`);
  return index;
}

function findPane(state: WorkspaceLayoutState, paneId: string): LocatedPane {
  for (let tabIndex = 0; tabIndex < state.tabs.length; tabIndex += 1) {
    const tab = state.tabs[tabIndex];
    if (!tab) continue;
    const leaf = orderedPaneLeaves(tab.root).find((pane) => pane.paneId === paneId);
    if (leaf) return { tabIndex, leaf };
  }
  throw new LayoutValidationError(`unknown pane: ${paneId}`);
}

function replacePane(
  node: LayoutNode,
  paneId: string,
  replacement: (leaf: PaneLeaf) => LayoutNode,
): { root: LayoutNode; replaced: boolean } {
  if (node.type === 'pane') {
    if (node.paneId === paneId) return { root: replacement(cloneLeaf(node)), replaced: true };
    return { root: cloneLeaf(node), replaced: false };
  }
  const first = replacePane(node.first, paneId, replacement);
  if (first.replaced) {
    return {
      root: { ...node, first: first.root, second: cloneNode(node.second) },
      replaced: true,
    };
  }
  const second = replacePane(node.second, paneId, replacement);
  return {
    root: { ...node, first: first.root, second: second.root },
    replaced: second.replaced,
  };
}

function removePaneFromNode(node: LayoutNode, paneId: string): NodeRemoval {
  if (node.type === 'pane') {
    return node.paneId === paneId
      ? { root: null, removed: cloneLeaf(node) }
      : { root: cloneLeaf(node), removed: null };
  }

  const first = removePaneFromNode(node.first, paneId);
  if (first.removed) {
    return first.root === null
      ? { root: cloneNode(node.second), removed: first.removed }
      : {
          root: { ...node, first: first.root, second: cloneNode(node.second) },
          removed: first.removed,
        };
  }
  const second = removePaneFromNode(node.second, paneId);
  if (second.removed) {
    return second.root === null
      ? { root: cloneNode(node.first), removed: second.removed }
      : {
          root: { ...node, first: first.root ?? cloneNode(node.first), second: second.root },
          removed: second.removed,
        };
  }
  return {
    root: { ...node, first: first.root ?? cloneNode(node.first), second: second.root ?? cloneNode(node.second) },
    removed: null,
  };
}

function splitAround(
  existing: PaneLeaf,
  inserted: PaneLeaf,
  splitId: string,
  direction: SplitDirection,
  position: SplitPosition,
): SplitBranch {
  const first = position === 'before' ? inserted : existing;
  const second = position === 'before' ? existing : inserted;
  return {
    type: 'split',
    splitId,
    direction,
    ratio: 0.5,
    first: cloneLeaf(first),
    second: cloneLeaf(second),
  };
}

function fallbackTabId(tabs: readonly TabLayout[], removedIndex: number): string {
  const fallback = tabs[Math.min(removedIndex, tabs.length - 1)];
  if (!fallback) throw new LayoutValidationError('workspace layout must retain at least one tab');
  return fallback.tabId;
}

function buildEqualAxis(
  nodes: readonly LayoutNode[],
  direction: SplitDirection,
  nextSplitId: () => string,
): LayoutNode {
  const first = nodes[0];
  if (!first) throw new LayoutValidationError('cannot build an empty layout axis');
  if (nodes.length === 1) return cloneNode(first);
  return {
    type: 'split',
    splitId: nextSplitId(),
    direction,
    ratio: 1 / nodes.length,
    first: cloneNode(first),
    second: buildEqualAxis(nodes.slice(1), direction, nextSplitId),
  };
}

export function seedWorkspaceLayout(
  workspace: SchemaFourWorkspaceLayoutSource,
  ids: SeedWorkspaceLayoutIds,
): WorkspaceLayoutState {
  const sessionCount = workspace.sessions.length;
  if (sessionCount < 1 || sessionCount > MAX_WORKSPACE_PANES) {
    throw new LayoutValidationError(`seed workspace must contain 1-${MAX_WORKSPACE_PANES} sessions`);
  }
  const columns = workspace.layout.columns;
  if (!Number.isInteger(columns) || columns < 1 || columns > sessionCount) {
    throw new LayoutValidationError('seed workspace columns must be between 1 and its session count');
  }
  if (ids.splitIds.length !== sessionCount - 1) {
    throw new LayoutValidationError(`seed workspace requires exactly ${sessionCount - 1} split IDs`);
  }
  if (ids.paneIds && ids.paneIds.length !== sessionCount) {
    throw new LayoutValidationError(`seed workspace requires exactly ${sessionCount} pane IDs`);
  }

  const leaves = workspace.sessions.map((session, index): PaneLeaf => ({
    type: 'pane',
    paneId: ids.paneIds?.[index] ?? session.id,
    sessionKey: session.id,
  }));
  let splitIndex = 0;
  const nextSplitId = (): string => {
    const splitId = ids.splitIds[splitIndex];
    splitIndex += 1;
    if (!splitId) throw new LayoutValidationError('missing supplied split ID');
    return splitId;
  };
  const rows: LayoutNode[] = [];
  for (let index = 0; index < leaves.length; index += columns) {
    rows.push(buildEqualAxis(leaves.slice(index, index + columns), 'horizontal', nextSplitId));
  }
  const root = buildEqualAxis(rows, 'vertical', nextSplitId);
  const firstPane = leaves[0];
  if (!firstPane) throw new LayoutValidationError('seed workspace must contain a pane');
  return finish({
    activeTabId: ids.tabId,
    tabs: [{
      tabId: ids.tabId,
      title: workspace.name,
      root,
      focusedPaneId: firstPane.paneId,
    }],
  });
}

export function orderedPaneLeaves(node: LayoutNode): PaneLeaf[] {
  if (node.type === 'pane') return [cloneLeaf(node)];
  return [...orderedPaneLeaves(node.first), ...orderedPaneLeaves(node.second)];
}

export function orderedSplitIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [];
  return [node.splitId, ...orderedSplitIds(node.first), ...orderedSplitIds(node.second)];
}

function paneAncestorPath(node: LayoutNode, paneId: string): PaneAncestorSplit[] | null {
  if (node.type === 'pane') return node.paneId === paneId ? [] : null;
  const firstPath = paneAncestorPath(node.first, paneId);
  if (firstPath) {
    return [...firstPath, {
      splitId: node.splitId,
      direction: node.direction,
      ratio: node.ratio,
      panePosition: 'first',
    }];
  }
  const secondPath = paneAncestorPath(node.second, paneId);
  if (!secondPath) return null;
  return [...secondPath, {
    splitId: node.splitId,
    direction: node.direction,
    ratio: node.ratio,
    panePosition: 'second',
  }];
}

/** Returns split IDs from the pane's nearest parent through the root. */
export function ancestorSplitIds(node: LayoutNode, paneId: string): string[] {
  return paneAncestorPath(node, paneId)?.map((split) => split.splitId) ?? [];
}

/**
 * Finds the nearest split ancestor of a pane. Direction and child-position
 * filters make this suitable for finding a pane's directional border.
 */
export function findNearestAncestorSplit(
  node: LayoutNode,
  paneId: string,
  direction?: SplitDirection,
  panePosition?: SplitChildPosition,
): PaneAncestorSplit | null {
  const path = paneAncestorPath(node, paneId);
  if (!path) return null;
  const match = path.find((split) => (
    (direction === undefined || split.direction === direction)
    && (panePosition === undefined || split.panePosition === panePosition)
  ));
  return match ? { ...match } : null;
}

/**
 * Computes a bounded ratio delta for moving the nearest border in the given
 * direction. A null result means the pane has no border on that side.
 */
export function computeDirectionalResizeDelta(
  node: LayoutNode,
  paneId: string,
  resizeDirection: PaneResizeDirection,
  step = 0.05,
): DirectionalSplitResize | null {
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0 || step > 1) {
    throw new LayoutValidationError('resize step must be a finite number between 0 and 1');
  }
  const horizontal = resizeDirection === 'left' || resizeDirection === 'right';
  const panePosition: SplitChildPosition = resizeDirection === 'left' || resizeDirection === 'up'
    ? 'second'
    : 'first';
  const split = findNearestAncestorSplit(
    node,
    paneId,
    horizontal ? 'horizontal' : 'vertical',
    panePosition,
  );
  if (!split) return null;
  const requestedDelta = panePosition === 'first' ? step : -step;
  const nextRatio = Number(Math.min(
    MAX_SPLIT_RATIO,
    Math.max(MIN_SPLIT_RATIO, split.ratio + requestedDelta),
  ).toFixed(12));
  return {
    ...split,
    delta: Number((nextRatio - split.ratio).toFixed(12)),
    nextRatio,
  };
}

function layoutIds(state: WorkspaceLayoutState): Set<string> {
  const ids = new Set<string>();
  const visit = (node: LayoutNode): void => {
    if (node.type === 'pane') {
      ids.add(node.paneId);
      return;
    }
    ids.add(node.splitId);
    visit(node.first);
    visit(node.second);
  };
  for (const tab of state.tabs) {
    ids.add(tab.tabId);
    visit(tab.root);
  }
  return ids;
}

function allocateLayoutId(preferred: string, used: Set<string>): string {
  const bounded = preferred.slice(0, MAX_LAYOUT_IDENTIFIER_BYTES);
  let candidate = bounded;
  let suffix = 2;
  while (used.has(candidate)) {
    const marker = `-${suffix}`;
    candidate = `${bounded.slice(0, MAX_LAYOUT_IDENTIFIER_BYTES - marker.length)}${marker}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function seedIds(workspace: SchemaFourWorkspaceLayoutSource): SeedWorkspaceLayoutIds {
  const used = new Set(workspace.sessions.map((session) => session.id));
  return {
    tabId: allocateLayoutId(`tab-${workspace.name.replace(/[^A-Za-z0-9_.-]/gu, '-') || 'workspace'}`, used),
    splitIds: workspace.sessions.slice(1).map((_session, index) => (
      allocateLayoutId(`split-${index + 1}`, used)
    )),
    paneIds: workspace.sessions.map((session) => session.id),
  };
}

/**
 * Reconciles durable layout state with the configured session catalog. Surviving
 * tabs and trees are retained. Removed sessions are pruned and newly configured
 * sessions become deterministic one-pane tabs.
 */
export function reconcileWorkspaceLayout(
  workspace: SchemaFourWorkspaceLayoutSource,
  persisted?: WorkspaceLayoutState,
): WorkspaceLayoutReconciliation {
  if (workspace.sessions.length < 1 || workspace.sessions.length > MAX_WORKSPACE_PANES) {
    throw new LayoutValidationError(`workspace must contain 1-${MAX_WORKSPACE_PANES} sessions`);
  }
  const configured = new Map(workspace.sessions.map((session) => [session.id, session]));
  if (configured.size !== workspace.sessions.length) {
    throw new LayoutValidationError('workspace sessions must have unique ids');
  }

  if (!persisted) {
    return {
      state: seedWorkspaceLayout(workspace, seedIds(workspace)),
      changed: true,
      addedSessionKeys: workspace.sessions.map((session) => session.id),
      removedSessionKeys: [],
    };
  }

  let state = validateWorkspaceLayoutState(persisted);
  const original = JSON.stringify(state);
  const removedSessionKeys = orderedDepthFirstPanes(state)
    .filter((leaf) => !configured.has(leaf.sessionKey))
    .map((leaf) => leaf.sessionKey);
  const survivingCount = orderedDepthFirstPanes(state).length - removedSessionKeys.length;
  if (survivingCount === 0) {
    return {
      state: seedWorkspaceLayout(workspace, seedIds(workspace)),
      changed: true,
      addedSessionKeys: workspace.sessions.map((session) => session.id),
      removedSessionKeys,
    };
  }

  for (const leaf of orderedDepthFirstPanes(state)) {
    if (configured.has(leaf.sessionKey)) continue;
    const tab = state.tabs.find((candidate) => (
      orderedPaneLeaves(candidate.root).some((pane) => pane.paneId === leaf.paneId)
    ));
    if (!tab) continue;
    state = orderedPaneLeaves(tab.root).length === 1
      ? closeTab(state, tab.tabId).state
      : closePane(state, leaf.paneId).state;
  }

  const represented = new Set(orderedDepthFirstPanes(state).map((leaf) => leaf.sessionKey));
  const missing = workspace.sessions.filter((session) => !represented.has(session.id));
  const used = layoutIds(state);
  for (const session of missing) {
    const paneId = allocateLayoutId(session.id, used);
    state = addTab(state, {
      tabId: allocateLayoutId(`tab-${session.id}`, used),
      title: session.title,
      paneId,
      sessionKey: session.id,
      activate: false,
    });
  }

  return {
    state,
    changed: original !== JSON.stringify(state),
    addedSessionKeys: missing.map((session) => session.id),
    removedSessionKeys,
  };
}

export function orderedDepthFirstPanes(
  state: WorkspaceLayoutState,
  tabId?: string,
): PaneLeaf[] {
  const valid = validateWorkspaceLayoutState(state);
  if (tabId !== undefined) {
    const tab = valid.tabs[findTabIndex(valid, tabId)];
    return tab ? orderedPaneLeaves(tab.root) : [];
  }
  return valid.tabs.flatMap((tab) => orderedPaneLeaves(tab.root));
}

export function addTab(state: WorkspaceLayoutState, options: AddTabOptions): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  const index = checkedIndex(options.index ?? valid.tabs.length, valid.tabs.length, 'tab index');
  const tab: TabLayout = {
    tabId: options.tabId,
    title: options.title,
    root: { type: 'pane', paneId: options.paneId, sessionKey: options.sessionKey },
    focusedPaneId: options.paneId,
  };
  const tabs = valid.tabs.map(cloneTab);
  tabs.splice(index, 0, tab);
  return finish({
    activeTabId: options.activate === false ? valid.activeTabId : options.tabId,
    tabs,
  });
}

export function renameTab(
  state: WorkspaceLayoutState,
  tabId: string,
  title: string,
): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  const index = findTabIndex(valid, tabId);
  return finish({
    activeTabId: valid.activeTabId,
    tabs: valid.tabs.map((tab, tabIndex) => (
      tabIndex === index ? { ...cloneTab(tab), title } : cloneTab(tab)
    )),
  });
}

export function moveTab(
  state: WorkspaceLayoutState,
  tabId: string,
  toIndex: number,
): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  const fromIndex = findTabIndex(valid, tabId);
  checkedIndex(toIndex, valid.tabs.length - 1, 'tab destination index');
  const tabs = valid.tabs.map(cloneTab);
  const removed = tabs.splice(fromIndex, 1)[0];
  if (!removed) throw new LayoutValidationError(`unknown tab: ${tabId}`);
  tabs.splice(toIndex, 0, removed);
  return finish({ activeTabId: valid.activeTabId, tabs });
}

export function activateTab(state: WorkspaceLayoutState, tabId: string): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  findTabIndex(valid, tabId);
  return finish({ activeTabId: tabId, tabs: valid.tabs.map(cloneTab) });
}

export function closeTab(state: WorkspaceLayoutState, tabId: string): LayoutRemovalResult {
  const valid = validateWorkspaceLayoutState(state);
  if (valid.tabs.length === 1) throw new LayoutValidationError('cannot close the last workspace tab');
  const index = findTabIndex(valid, tabId);
  const removedTab = valid.tabs[index];
  if (!removedTab) throw new LayoutValidationError(`unknown tab: ${tabId}`);
  const tabs = valid.tabs.filter((_tab, tabIndex) => tabIndex !== index).map(cloneTab);
  return {
    state: finish({
      activeTabId: valid.activeTabId === tabId ? fallbackTabId(tabs, index) : valid.activeTabId,
      tabs,
    }),
    removedLeaves: orderedPaneLeaves(removedTab.root),
  };
}

export function focusPane(state: WorkspaceLayoutState, paneId: string): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  const located = findPane(valid, paneId);
  const targetTab = valid.tabs[located.tabIndex];
  if (!targetTab) throw new LayoutValidationError(`unknown pane: ${paneId}`);
  return finish({
    activeTabId: targetTab.tabId,
    tabs: valid.tabs.map((tab, index) => (
      index === located.tabIndex ? { ...cloneTab(tab), focusedPaneId: paneId } : cloneTab(tab)
    )),
  });
}

export function splitPane(
  state: WorkspaceLayoutState,
  options: SplitPaneOptions,
): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  const located = findPane(valid, options.paneId);
  const targetTab = valid.tabs[located.tabIndex];
  if (!targetTab) throw new LayoutValidationError(`unknown pane: ${options.paneId}`);
  const inserted: PaneLeaf = {
    type: 'pane',
    paneId: options.newPaneId,
    sessionKey: options.newSessionKey,
  };
  const replaced = replacePane(targetTab.root, options.paneId, (existing) => splitAround(
    existing,
    inserted,
    options.splitId,
    options.direction,
    options.position,
  ));
  if (!replaced.replaced) throw new LayoutValidationError(`unknown pane: ${options.paneId}`);
  return finish({
    activeTabId: targetTab.tabId,
    tabs: valid.tabs.map((tab, index) => index === located.tabIndex
      ? { ...cloneTab(tab), root: replaced.root, focusedPaneId: options.newPaneId }
      : cloneTab(tab)),
  });
}

export function movePane(
  state: WorkspaceLayoutState,
  options: MovePaneOptions,
): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  if (options.paneId === options.targetPaneId) {
    throw new LayoutValidationError('a pane cannot be moved relative to itself');
  }
  const source = findPane(valid, options.paneId);
  findPane(valid, options.targetPaneId);
  const sourceTab = valid.tabs[source.tabIndex];
  if (!sourceTab) throw new LayoutValidationError(`unknown pane: ${options.paneId}`);
  const removal = removePaneFromNode(sourceTab.root, options.paneId);
  if (!removal.removed) throw new LayoutValidationError(`unknown pane: ${options.paneId}`);

  let tabs: TabLayout[];
  if (removal.root === null) {
    tabs = valid.tabs.filter((_tab, index) => index !== source.tabIndex).map(cloneTab);
  } else {
    const fallbackPane = orderedPaneLeaves(removal.root)[0];
    if (!fallbackPane) throw new LayoutValidationError('source tab must retain a pane');
    tabs = valid.tabs.map((tab, index) => index === source.tabIndex
      ? {
          ...cloneTab(tab),
          root: removal.root as LayoutNode,
          focusedPaneId: tab.focusedPaneId === options.paneId
            ? fallbackPane.paneId
            : tab.focusedPaneId,
        }
      : cloneTab(tab));
  }

  const interim: WorkspaceLayoutState = {
    activeTabId: tabs.some((tab) => tab.tabId === valid.activeTabId)
      ? valid.activeTabId
      : (tabs[0]?.tabId ?? ''),
    tabs,
  };
  const target = findPane(interim, options.targetPaneId);
  const targetTab = tabs[target.tabIndex];
  if (!targetTab) throw new LayoutValidationError(`unknown pane: ${options.targetPaneId}`);
  const replaced = replacePane(targetTab.root, options.targetPaneId, (existing) => splitAround(
    existing,
    removal.removed as PaneLeaf,
    options.splitId,
    options.direction,
    options.position,
  ));
  if (!replaced.replaced) throw new LayoutValidationError(`unknown pane: ${options.targetPaneId}`);
  tabs = tabs.map((tab, index) => index === target.tabIndex
    ? { ...cloneTab(tab), root: replaced.root, focusedPaneId: options.paneId }
    : cloneTab(tab));
  return finish({ activeTabId: targetTab.tabId, tabs });
}

export function closePane(state: WorkspaceLayoutState, paneId: string): LayoutRemovalResult {
  const valid = validateWorkspaceLayoutState(state);
  const located = findPane(valid, paneId);
  const tab = valid.tabs[located.tabIndex];
  if (!tab) throw new LayoutValidationError(`unknown pane: ${paneId}`);
  const panesBeforeRemoval = orderedPaneLeaves(tab.root);
  if (panesBeforeRemoval.length === 1) {
    throw new LayoutValidationError('cannot close the last pane in a tab');
  }
  const removedIndex = panesBeforeRemoval.findIndex((pane) => pane.paneId === paneId);
  const removal = removePaneFromNode(tab.root, paneId);
  if (!removal.removed) throw new LayoutValidationError(`unknown pane: ${paneId}`);

  if (removal.root === null) {
    throw new LayoutValidationError('cannot close the last pane in a tab');
  }

  const remainingPanes = orderedPaneLeaves(removal.root);
  const fallbackPane = remainingPanes[Math.min(removedIndex, remainingPanes.length - 1)];
  if (!fallbackPane) throw new LayoutValidationError('tab must retain a pane');
  return {
    state: finish({
      activeTabId: valid.activeTabId,
      tabs: valid.tabs.map((candidate, index) => index === located.tabIndex
        ? {
            ...cloneTab(candidate),
            root: removal.root as LayoutNode,
            focusedPaneId: candidate.focusedPaneId === paneId
              ? fallbackPane.paneId
              : candidate.focusedPaneId,
          }
        : cloneTab(candidate)),
    }),
    removedLeaves: [removal.removed],
  };
}

function resizeNode(node: LayoutNode, splitId: string, ratio: number): { root: LayoutNode; found: boolean } {
  if (node.type === 'pane') return { root: cloneLeaf(node), found: false };
  if (node.splitId === splitId) return { root: { ...node, ratio, first: cloneNode(node.first), second: cloneNode(node.second) }, found: true };
  const first = resizeNode(node.first, splitId, ratio);
  if (first.found) {
    return { root: { ...node, first: first.root, second: cloneNode(node.second) }, found: true };
  }
  const second = resizeNode(node.second, splitId, ratio);
  return { root: { ...node, first: first.root, second: second.root }, found: second.found };
}

export function resizeSplit(
  state: WorkspaceLayoutState,
  splitId: string,
  ratio: number,
): WorkspaceLayoutState {
  const valid = validateWorkspaceLayoutState(state);
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    throw new LayoutValidationError('split ratio must be a finite number');
  }
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  let found = false;
  const tabs = valid.tabs.map((tab) => {
    if (found) return cloneTab(tab);
    const resized = resizeNode(tab.root, splitId, clamped);
    found = resized.found;
    return { ...cloneTab(tab), root: resized.root };
  });
  if (!found) throw new LayoutValidationError(`unknown split: ${splitId}`);
  return finish({ activeTabId: valid.activeTabId, tabs });
}
