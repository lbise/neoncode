const { _electron: electron } = require('playwright');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const endpoint = process.env.NEONCODE_HUB_ENDPOINT || 'ws://127.0.0.1:44777/ws';
const timeout = Number.parseInt(process.env.NEONCODE_PLAYWRIGHT_TIMEOUT || '20000', 10);
const paneIds = ['shell', 'tasks'];

function log(message, details) {
  const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[electron-test] ${message}${payload}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function summarizeState(state) {
  return {
    panes: state.panes.map(({ recentOutput, ...pane }) => ({
      ...pane,
      recentOutputChars: recentOutput.length,
    })),
    sessionDiscovery: state.sessionDiscovery,
  };
}

async function launchApp(sessionPrefix) {
  const electronApp = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    env: {
      ...process.env,
      NEONCODE_HUB_ENDPOINT: endpoint,
      NEONCODE_PERSIST_SESSIONS: '1',
      NEONCODE_SESSION_PREFIX: sessionPrefix,
      NEONCODE_TERMINAL_COUNT: '2',
      NEONCODE_TEST_MODE: '1',
    },
  });
  const consoleMessages = [];
  const page = await electronApp.firstWindow({ timeout });
  page.on('console', (message) => {
    consoleMessages.push(message.text());
    if (consoleMessages.length > 200) {
      consoleMessages.shift();
    }
  });

  await page.waitForSelector('[data-testid="app-header"]', { state: 'attached', timeout });
  await page.waitForFunction(() => Boolean(window.neoncodeTest), null, { timeout });
  await page.waitForFunction(
    () => {
      const state = window.neoncodeTest?.getState();
      return state?.sessionDiscovery?.status === 'ready'
        && state.panes.length === 2
        && state.panes.every((pane) => pane.started);
    },
    null,
    { timeout },
  );

  return { electronApp, page, consoleMessages };
}

async function getState(page) {
  return page.evaluate(() => window.neoncodeTest.getState());
}

async function sendText(page, paneId, text) {
  await page.evaluate(
    ({ targetPaneId, input }) => window.neoncodeTest.sendText(targetPaneId, input),
    { targetPaneId: paneId, input: text },
  );
}

async function pasteText(page, paneId, text) {
  await page.evaluate(
    ({ targetPaneId, input }) => window.neoncodeTest.pasteText(targetPaneId, input),
    { targetPaneId: paneId, input: text },
  );
}

async function waitForOutput(page, paneId, expected) {
  await page.waitForFunction(
    ({ targetPaneId, output }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === targetPaneId);
      return pane?.recentOutput.includes(output);
    },
    { targetPaneId: paneId, output: expected },
    { timeout },
  );
}

async function waitForEitherOutput(page, paneId, expectedValues) {
  await page.waitForFunction(
    ({ targetPaneId, outputs }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === targetPaneId);
      return outputs.some((output) => pane?.recentOutput.includes(output));
    },
    { targetPaneId: paneId, outputs: expectedValues },
    { timeout },
  );

  const pane = (await getState(page)).panes.find((candidate) => candidate.paneId === paneId);
  return expectedValues.find((output) => pane.recentOutput.includes(output));
}

function assertMarkerIsNotEchoed(command, expected) {
  assert(!command.includes(expected), `test command contains expected output marker: ${expected}`);
}

async function verifyExecutedCommand(page, paneId, label, token) {
  const expected = `${label}-${token}`;
  const command = `printf '${label}-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(command, expected);

  const before = await getState(page);
  const beforeInputEvents = before.panes.find((pane) => pane.paneId === paneId).inputEvents;
  await sendText(page, paneId, command);
  await waitForOutput(page, paneId, expected);

  const after = await getState(page);
  const afterInputEvents = after.panes.find((pane) => pane.paneId === paneId).inputEvents;
  assert(afterInputEvents === beforeInputEvents + 1, `${paneId} input event was not recorded exactly once`);
}

async function assertPaneLifecycles(instance, expectedLifecycle) {
  const state = await getState(instance.page);
  for (const pane of state.panes) {
    assert(
      pane.lifecycle === expectedLifecycle,
      `${pane.paneId} expected lifecycle ${expectedLifecycle}, got ${pane.lifecycle}`,
    );
    assert(
      pane.activationMode === (expectedLifecycle === 'attached' ? 'attach' : 'start'),
      `${pane.paneId} activation mode did not match ${expectedLifecycle}`,
    );
    const uiState = await instance.page
      .locator(`[data-testid="pane-status-${pane.paneId}"]`)
      .getAttribute('data-state');
    assert(uiState === expectedLifecycle, `${pane.paneId} UI status expected ${expectedLifecycle}, got ${uiState}`);
  }
}

async function killAllPanes(instance) {
  await instance.page.evaluate(async (targets) => {
    await Promise.all(targets.map((paneId) => window.neoncodeTest.killPane(paneId)));
  }, paneIds);
  const state = await getState(instance.page);
  assert(state.panes.every((pane) => pane.lifecycle === 'killed'), 'test sessions were not killed');
}

async function closeInstance(instance) {
  if (!instance) {
    return;
  }
  await instance.electronApp.close();
}

async function cleanupSessions(sessionPrefix) {
  let cleanupInstance;
  try {
    cleanupInstance = await launchApp(sessionPrefix);
    await killAllPanes(cleanupInstance);
  } catch (error) {
    log('cleanup.failed', { message: error.message });
  } finally {
    await closeInstance(cleanupInstance).catch(() => {});
  }
}

async function runFirstLaunchChecks(instance, sessionPrefix, runToken) {
  const { electronApp, page } = instance;
  const windowState = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window.isVisible(), contentSize: window.getContentSize() };
  });
  assert(windowState.visible === false, 'test-mode Electron window should remain hidden');

  const initialState = await getState(page);
  log('state.first-launch', summarizeState(initialState));
  assert(initialState.sessionDiscovery.sessionListEvents >= 1, 'startup did not list hub sessions');
  assert(initialState.sessionDiscovery.sessions.length === 0, 'fresh test prefix unexpectedly found sessions');

  const expectedPanes = [
    { paneId: 'shell', sessionKey: 'shell', sessionId: `${sessionPrefix}-shell` },
    { paneId: 'tasks', sessionKey: 'tasks', sessionId: `${sessionPrefix}-tasks` },
  ];
  for (const expected of expectedPanes) {
    const actual = initialState.panes.find((pane) => pane.paneId === expected.paneId);
    for (const key of ['paneId', 'sessionKey', 'sessionId']) {
      assert(actual?.[key] === expected[key], `${expected.paneId} expected ${key}=${expected[key]}, got ${actual?.[key]}`);
    }
  }
  await assertPaneLifecycles(instance, 'started');

  await verifyExecutedCommand(page, 'shell', 'shell-command', runToken);
  await verifyExecutedCommand(page, 'tasks', 'tasks-command', runToken);

  const pasteExpected = `paste-${runToken}`;
  const pasteCommand = `printf 'paste-%s\\n' '${runToken}'\r\n`;
  assertMarkerIsNotEchoed(pasteCommand, pasteExpected);
  await pasteText(page, 'shell', pasteCommand);
  await waitForOutput(page, 'shell', pasteExpected);

  const armedExpected = `armed-${runToken}`;
  const signalExpected = `signal-${runToken}`;
  const signalCommand = `trap 'printf "signal-%s\\n" "${runToken}"' INT; printf 'armed-%s\\n' '${runToken}'; sleep 30\n`;
  assertMarkerIsNotEchoed(signalCommand, armedExpected);
  assertMarkerIsNotEchoed(signalCommand, signalExpected);
  await sendText(page, 'shell', signalCommand);
  await waitForOutput(page, 'shell', armedExpected);
  await sendText(page, 'shell', '\x03');
  await waitForOutput(page, 'shell', signalExpected);

  const tmuxValues = [`tool-tmux-present-${runToken}`, `tool-tmux-missing-${runToken}`];
  const tmuxCommand = `if command -v tmux >/dev/null 2>&1; then v=present; else v=missing; fi; printf 'tool-tmux-%s-%s\\n' "$v" '${runToken}'\n`;
  for (const value of tmuxValues) {
    assertMarkerIsNotEchoed(tmuxCommand, value);
  }
  await sendText(page, 'tasks', tmuxCommand);
  const tmuxResult = await waitForEitherOutput(page, 'tasks', tmuxValues);

  const nvimValues = [`tool-nvim-present-${runToken}`, `tool-nvim-missing-${runToken}`];
  const nvimCommand = `if command -v nvim >/dev/null 2>&1; then v=present; else v=missing; fi; printf 'tool-nvim-%s-%s\\n' "$v" '${runToken}'\n`;
  for (const value of nvimValues) {
    assertMarkerIsNotEchoed(nvimCommand, value);
  }
  await sendText(page, 'tasks', nvimCommand);
  const nvimResult = await waitForEitherOutput(page, 'tasks', nvimValues);

  const beforeResize = await getState(page);
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1400, 900);
  });
  await page.waitForFunction(
    (before) => {
      const state = window.neoncodeTest.getState();
      return state.panes.every((pane, index) => pane.resizeEvents > before[index].resizeEvents)
        && state.panes.some((pane, index) => pane.rows !== before[index].rows || pane.cols !== before[index].cols);
    },
    beforeResize.panes.map(({ resizeEvents, rows, cols }) => ({ resizeEvents, rows, cols })),
    { timeout },
  );

  const resizedState = await getState(page);
  for (const pane of resizedState.panes) {
    const expected = `size-${pane.rows}x${pane.cols}-${runToken}`;
    const command = `printf 'size-%sx%s-%s\\n' $(stty size) '${runToken}'\n`;
    assertMarkerIsNotEchoed(command, expected);
    await sendText(page, pane.paneId, command);
    await waitForOutput(page, pane.paneId, expected);
  }

  const seedExpected = `seed-${runToken}`;
  const seedCommand = `export NEONCODE_TEST_PERSIST='${runToken}'; printf 'seed-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(seedCommand, seedExpected);
  await sendText(page, 'shell', seedCommand);
  await waitForOutput(page, 'shell', seedExpected);

  log('tools', { tmux: tmuxResult, nvim: nvimResult });
}

async function runSecondLaunchChecks(instance, sessionPrefix, runToken) {
  const state = await getState(instance.page);
  log('state.second-launch', summarizeState(state));
  const expectedSessionIds = [`${sessionPrefix}-shell`, `${sessionPrefix}-tasks`];
  for (const sessionId of expectedSessionIds) {
    assert(
      state.sessionDiscovery.sessions.includes(sessionId),
      `session discovery did not find persisted session ${sessionId}`,
    );
  }
  await assertPaneLifecycles(instance, 'attached');

  const restoredExpected = `restored-${runToken}`;
  const restoredCommand = `printf 'restored-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(restoredCommand, restoredExpected);
  await sendText(instance.page, 'shell', restoredCommand);
  await waitForOutput(instance.page, 'shell', restoredExpected);
}

async function main() {
  log('launch', { appRoot, endpoint });
  const runToken = `${Date.now()}`;
  const sessionPrefix = `electron-playwright-${runToken}`;
  let instance;
  let sessionsCleaned = false;

  try {
    instance = await launchApp(sessionPrefix);
    await runFirstLaunchChecks(instance, sessionPrefix, runToken);
    await closeInstance(instance);
    instance = undefined;

    instance = await launchApp(sessionPrefix);
    await runSecondLaunchChecks(instance, sessionPrefix, runToken);
    await killAllPanes(instance);
    sessionsCleaned = true;

    const finalState = await getState(instance.page);
    log('state.final', summarizeState(finalState));
    log('passed');
  } catch (error) {
    log('failed', { message: error.message, consoleMessages: instance?.consoleMessages || [] });
    throw error;
  } finally {
    if (instance) {
      if (!sessionsCleaned) {
        try {
          await killAllPanes(instance);
          sessionsCleaned = true;
        } catch {
          // A fallback cleanup launch below will retry.
        }
      }
      await closeInstance(instance).catch(() => {});
    }
    if (!sessionsCleaned) {
      await cleanupSessions(sessionPrefix);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
