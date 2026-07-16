import assert = require('node:assert/strict');

import {
  activateTab,
  addTab,
  closePane,
  closeTab,
  focusPane,
  movePane,
  moveTab,
  orderedDepthFirstPanes,
  renameTab,
  resizeSplit,
  seedWorkspaceLayout,
  splitPane,
  validateWorkspaceLayoutState,
  type LayoutNode,
  type PaneLeaf,
  type WorkspaceLayoutState,
} from '../renderer/layout-model';

const sourceWorkspace = {
  name: 'Development',
  layout: { columns: 2 },
  sessions: [
    { id: 'shell', title: 'Shell' },
    { id: 'tasks', title: 'Tasks' },
    { id: 'agent', title: 'Agent' },
    { id: 'logs', title: 'Logs' },
  ],
};

function seed(): WorkspaceLayoutState {
  return seedWorkspaceLayout(sourceWorkspace, {
    tabId: 'tab-main',
    paneIds: ['pane-shell', 'pane-tasks', 'pane-agent', 'pane-logs'],
    splitIds: ['split-row-1', 'split-row-2', 'split-rows'],
  });
}

function paneIds(state: WorkspaceLayoutState, tabId?: string): string[] {
  return orderedDepthFirstPanes(state, tabId).map((pane) => pane.paneId);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function nestedLayout(depth: number): WorkspaceLayoutState {
  let root: LayoutNode = { type: 'pane', paneId: `pane-${depth}`, sessionKey: `session-${depth}` };
  for (let current = depth - 1; current >= 1; current -= 1) {
    root = {
      type: 'split',
      splitId: `split-${current}`,
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'pane', paneId: `pane-${current}`, sessionKey: `session-${current}` },
      second: root,
    };
  }
  return {
    activeTabId: 'tab-nested',
    tabs: [{
      tabId: 'tab-nested',
      title: 'Nested',
      root,
      focusedPaneId: 'pane-1',
    }],
  };
}

function testSchemaFourGridSeedAndOrder(): void {
  const state = seed();
  assert.equal(state.activeTabId, 'tab-main');
  assert.equal(state.tabs[0]?.title, 'Development');
  assert.equal(state.tabs[0]?.focusedPaneId, 'pane-shell');
  assert.deepEqual(paneIds(state), ['pane-shell', 'pane-tasks', 'pane-agent', 'pane-logs']);

  const root = state.tabs[0]?.root;
  assert(root?.type === 'split');
  assert.equal(root.direction, 'vertical');
  assert.equal(root.ratio, 0.5);
  assert(root.first.type === 'split');
  assert.equal(root.first.direction, 'horizontal');
  assert.equal(root.first.splitId, 'split-row-1');
  assert(root.second.type === 'split');
  assert.equal(root.second.splitId, 'split-row-2');

  const onePane = seedWorkspaceLayout({
    name: 'One',
    layout: { columns: 1 },
    sessions: [{ id: 'only', title: 'Only' }],
  }, { tabId: 'one-tab', splitIds: [] });
  assert.deepEqual(paneIds(onePane), ['only']);
  assert.throws(
    () => seedWorkspaceLayout(sourceWorkspace, { tabId: 'bad', splitIds: ['one'] }),
    /exactly 3 split IDs/,
  );
}

function testTabOperationsAndRemovedLeaves(): void {
  const original = deepFreeze(seed());
  const before = JSON.stringify(original);
  const added = addTab(original, {
    tabId: 'tab-review',
    title: 'Review',
    paneId: 'pane-review',
    sessionKey: 'review',
    index: 0,
  });
  assert.equal(JSON.stringify(original), before, 'addTab mutated its input');
  assert.deepEqual(added.tabs.map((tab) => tab.tabId), ['tab-review', 'tab-main']);
  assert.equal(added.activeTabId, 'tab-review');

  const renamed = renameTab(added, 'tab-review', 'Code review');
  assert.equal(renamed.tabs[0]?.title, 'Code review');
  assert.equal(added.tabs[0]?.title, 'Review');

  const moved = moveTab(renamed, 'tab-review', 1);
  assert.deepEqual(moved.tabs.map((tab) => tab.tabId), ['tab-main', 'tab-review']);
  const activated = activateTab(moved, 'tab-main');
  assert.equal(activated.activeTabId, 'tab-main');

  const closed = closeTab(activated, 'tab-main');
  assert.equal(closed.state.activeTabId, 'tab-review');
  assert.deepEqual(closed.removedLeaves.map((pane) => pane.paneId), [
    'pane-shell', 'pane-tasks', 'pane-agent', 'pane-logs',
  ]);
  assert.deepEqual(paneIds(closed.state), ['pane-review']);
  assert.throws(() => closeTab(closed.state, 'tab-review'), /last workspace tab/);
  assert.throws(() => moveTab(closed.state, 'tab-review', 1), /destination index/);
}

function testFocusSplitCloseAndResize(): void {
  const focused = focusPane(seed(), 'pane-agent');
  assert.equal(focused.tabs[0]?.focusedPaneId, 'pane-agent');

  const before = splitPane(focused, {
    paneId: 'pane-agent',
    newPaneId: 'pane-before',
    newSessionKey: 'before',
    splitId: 'split-before',
    direction: 'vertical',
    position: 'before',
  });
  assert.deepEqual(paneIds(before), [
    'pane-shell', 'pane-tasks', 'pane-before', 'pane-agent', 'pane-logs',
  ]);
  assert.equal(before.tabs[0]?.focusedPaneId, 'pane-before');

  const after = splitPane(before, {
    paneId: 'pane-tasks',
    newPaneId: 'pane-after',
    newSessionKey: 'after',
    splitId: 'split-after',
    direction: 'horizontal',
    position: 'after',
  });
  assert.deepEqual(paneIds(after), [
    'pane-shell', 'pane-tasks', 'pane-after', 'pane-before', 'pane-agent', 'pane-logs',
  ]);

  const low = resizeSplit(after, 'split-after', -10);
  const lowRoot = low.tabs[0]?.root;
  assert(lowRoot);
  const findRatio = (node: LayoutNode, splitId: string): number | null => {
    if (node.type === 'pane') return null;
    if (node.splitId === splitId) return node.ratio;
    return findRatio(node.first, splitId) ?? findRatio(node.second, splitId);
  };
  assert.equal(findRatio(lowRoot, 'split-after'), 0.1);
  const high = resizeSplit(low, 'split-after', 10);
  assert.equal(findRatio(high.tabs[0]!.root, 'split-after'), 0.9);
  assert.throws(() => resizeSplit(high, 'missing', 0.5), /unknown split/);
  assert.throws(() => resizeSplit(high, 'split-after', Number.NaN), /finite/);

  const closed = closePane(high, 'pane-after');
  assert.deepEqual(closed.removedLeaves, [
    { type: 'pane', paneId: 'pane-after', sessionKey: 'after' },
  ]);
  assert.deepEqual(paneIds(closed.state), [
    'pane-shell', 'pane-tasks', 'pane-before', 'pane-agent', 'pane-logs',
  ]);
  assert.equal(findRatio(closed.state.tabs[0]!.root, 'split-after'), null, 'parent split did not collapse');
}

function testPaneMovesWithinAndAcrossTabs(): void {
  const withSecondTab = addTab(seed(), {
    tabId: 'tab-review',
    title: 'Review',
    paneId: 'pane-review',
    sessionKey: 'review',
  });
  const movedAcross = movePane(withSecondTab, {
    paneId: 'pane-review',
    targetPaneId: 'pane-tasks',
    splitId: 'split-review-target',
    direction: 'vertical',
    position: 'before',
  });
  assert.deepEqual(movedAcross.tabs.map((tab) => tab.tabId), ['tab-main']);
  assert.equal(movedAcross.activeTabId, 'tab-main');
  assert.equal(movedAcross.tabs[0]?.focusedPaneId, 'pane-review');
  assert.deepEqual(paneIds(movedAcross), [
    'pane-shell', 'pane-review', 'pane-tasks', 'pane-agent', 'pane-logs',
  ]);

  const movedWithin = movePane(movedAcross, {
    paneId: 'pane-shell',
    targetPaneId: 'pane-logs',
    splitId: 'split-shell-logs',
    direction: 'horizontal',
    position: 'after',
  });
  assert.deepEqual(paneIds(movedWithin), [
    'pane-review', 'pane-tasks', 'pane-agent', 'pane-logs', 'pane-shell',
  ]);
  assert.equal(movedWithin.tabs[0]?.focusedPaneId, 'pane-shell');
  assert.throws(() => movePane(movedWithin, {
    paneId: 'pane-shell',
    targetPaneId: 'pane-shell',
    splitId: 'unused',
    direction: 'horizontal',
    position: 'before',
  }), /relative to itself/);
}

function testClosingRootPaneRemovesItsTab(): void {
  const state = addTab(seed(), {
    tabId: 'tab-single',
    title: 'Single',
    paneId: 'pane-single',
    sessionKey: 'single',
  });
  const result = closePane(state, 'pane-single');
  assert.deepEqual(result.state.tabs.map((tab) => tab.tabId), ['tab-main']);
  assert.equal(result.state.activeTabId, 'tab-main');
  assert.deepEqual(result.removedLeaves, [
    { type: 'pane', paneId: 'pane-single', sessionKey: 'single' },
  ]);

  const only = seedWorkspaceLayout({
    name: 'Only',
    layout: { columns: 1 },
    sessions: [{ id: 'only', title: 'Only' }],
  }, { tabId: 'only-tab', splitIds: [] });
  assert.throws(() => closePane(only, 'only'), /last pane/);
}

function testStrictValidationAndLimits(): void {
  const state = seed();
  const validated = validateWorkspaceLayoutState(state);
  assert.deepEqual(validated, state);
  assert.notEqual(validated, state);
  assert.notEqual(validated.tabs[0]?.root, state.tabs[0]?.root);

  assert.throws(
    () => validateWorkspaceLayoutState({ ...state, unexpected: true }),
    /keys must be exactly/,
  );
  assert.throws(
    () => validateWorkspaceLayoutState({ ...state, activeTabId: 'missing' }),
    /activeTabId must reference/,
  );
  const badFocus = structuredClone(state);
  badFocus.tabs[0]!.focusedPaneId = 'missing';
  assert.throws(() => validateWorkspaceLayoutState(badFocus), /focusedPaneId must reference/);

  const duplicatePane = structuredClone(state);
  const duplicateLeaf = orderedDepthFirstPanes(duplicatePane)[1];
  assert(duplicateLeaf);
  const changeLeaf = (node: LayoutNode): boolean => {
    if (node.type === 'pane') {
      if (node.paneId === duplicateLeaf.paneId) {
        node.paneId = 'pane-shell';
        return true;
      }
      return false;
    }
    return changeLeaf(node.first) || changeLeaf(node.second);
  };
  changeLeaf(duplicatePane.tabs[0]!.root);
  assert.throws(() => validateWorkspaceLayoutState(duplicatePane), /duplicate layout id/);

  const duplicateSession = structuredClone(state);
  const setSession = (node: LayoutNode): boolean => {
    if (node.type === 'pane') {
      if (node.paneId === 'pane-tasks') {
        node.sessionKey = 'shell';
        return true;
      }
      return false;
    }
    return setSession(node.first) || setSession(node.second);
  };
  setSession(duplicateSession.tabs[0]!.root);
  assert.throws(() => validateWorkspaceLayoutState(duplicateSession), /duplicate session key/);

  const duplicateCrossType = structuredClone(state);
  assert(duplicateCrossType.tabs[0]?.root.type === 'split');
  duplicateCrossType.tabs[0].root.splitId = 'tab-main';
  assert.throws(() => validateWorkspaceLayoutState(duplicateCrossType), /duplicate layout id/);

  const invalidRatio = structuredClone(state);
  assert(invalidRatio.tabs[0]?.root.type === 'split');
  invalidRatio.tabs[0].root.ratio = 0.01;
  assert.throws(() => validateWorkspaceLayoutState(invalidRatio), /ratio must be between/);

  const overlongTitle = structuredClone(state);
  overlongTitle.tabs[0]!.title = '🙂'.repeat(17);
  assert.throws(() => validateWorkspaceLayoutState(overlongTitle), /UTF-8 bytes/);
  const exactTitle = structuredClone(state);
  exactTitle.tabs[0]!.title = '🙂'.repeat(16);
  assert.equal(validateWorkspaceLayoutState(exactTitle).tabs[0]?.title, exactTitle.tabs[0]?.title);

  assert.doesNotThrow(() => validateWorkspaceLayoutState(nestedLayout(8)));
  assert.throws(() => validateWorkspaceLayoutState(nestedLayout(9)), /depth may not exceed 8/);

  let maximum = seedWorkspaceLayout({
    name: 'Maximum',
    layout: { columns: 1 },
    sessions: Array.from({ length: 8 }, (_, index) => ({
      id: `maximum-${index}`,
      title: `Maximum ${index}`,
    })),
  }, {
    tabId: 'maximum-tab',
    splitIds: Array.from({ length: 7 }, (_, index) => `maximum-split-${index}`),
  });
  assert.equal(paneIds(maximum).length, 8);
  assert.throws(() => splitPane(maximum, {
    paneId: 'maximum-0',
    newPaneId: 'too-many',
    newSessionKey: 'too-many',
    splitId: 'too-many-split',
    direction: 'horizontal',
    position: 'after',
  }), /at most 8 panes/);

  let eightTabs = seedWorkspaceLayout({
    name: 'Tab 1',
    layout: { columns: 1 },
    sessions: [{ id: 'tab-session-1', title: 'Tab 1' }],
  }, { tabId: 'tab-1', paneIds: ['tab-pane-1'], splitIds: [] });
  for (let index = 2; index <= 8; index += 1) {
    eightTabs = addTab(eightTabs, {
      tabId: `tab-${index}`,
      title: `Tab ${index}`,
      paneId: `tab-pane-${index}`,
      sessionKey: `tab-session-${index}`,
    });
  }
  assert.equal(eightTabs.tabs.length, 8);
  assert.throws(() => addTab(eightTabs, {
    tabId: 'tab-9',
    title: 'Tab 9',
    paneId: 'tab-pane-9',
    sessionKey: 'tab-session-9',
  }), /1-8 tabs|at most 8 panes/);
}

function testSharedNodeAndCyclesAreRejected(): void {
  const leaf: PaneLeaf = { type: 'pane', paneId: 'shared', sessionKey: 'shared' };
  const shared = {
    activeTabId: 'tab',
    tabs: [{
      tabId: 'tab',
      title: 'Shared',
      focusedPaneId: 'shared',
      root: {
        type: 'split',
        splitId: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: leaf,
        second: leaf,
      },
    }],
  };
  assert.throws(() => validateWorkspaceLayoutState(shared), /reuse or cycle/);
}

for (const test of [
  testSchemaFourGridSeedAndOrder,
  testTabOperationsAndRemovedLeaves,
  testFocusSplitCloseAndResize,
  testPaneMovesWithinAndAcrossTabs,
  testClosingRootPaneRemovesItsTab,
  testStrictValidationAndLimits,
  testSharedNodeAndCyclesAreRejected,
]) {
  test();
}

console.log('layout-model tests passed');
