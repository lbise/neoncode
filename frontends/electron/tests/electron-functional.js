const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const electronExecutable = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const endpoint = process.env.NEONCODE_HUB_ENDPOINT || 'ws://127.0.0.1:44777/ws';
const timeout = Number.parseInt(process.env.NEONCODE_PLAYWRIGHT_TIMEOUT || '20000', 10);
const paneIds = ['shell', 'tasks'];

function writeTestConfig(directory, { persistencePolicy = 'detach' } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    hub: { endpoint: 'ws://127.0.0.1:44777/ws' },
    sessionPrefix: 'config-file-prefix',
    persistence: { onWindowClose: persistencePolicy },
    launchProfiles: {
      'default-shell': {
        type: 'process',
        command: 'bash',
        args: [],
        cwd: null,
      },
      'tasks-in-tmp': {
        type: 'process',
        command: 'bash',
        args: [],
        cwd: '/tmp',
      },
    },
    sessions: [
      { id: 'shell', title: 'Configured Shell', launchProfile: 'default-shell' },
      { id: 'tasks', title: 'Configured Tasks', launchProfile: 'tasks-in-tmp' },
    ],
  }, null, 2)}\n`);
}

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
    configuration: state.configuration,
    panes: state.panes.map(({ recentOutput, ...pane }) => ({
      ...pane,
      recentOutputChars: recentOutput.length,
    })),
    sessionDiscovery: state.sessionDiscovery,
  };
}

async function launchApp(sessionPrefix, configDirectory, { expectReady = true } = {}) {
  const launchEnvironment = {
    ...process.env,
    NEONCODE_HUB_ENDPOINT: endpoint,
    NEONCODE_SESSION_PREFIX: sessionPrefix,
    NEONCODE_TEST_CONFIG_DIR: configDirectory,
    NEONCODE_TEST_MODE: '1',
  };
  const electronApp = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    env: launchEnvironment,
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
    (shouldBeReady) => {
      const state = window.neoncodeTest?.getState();
      if (!shouldBeReady) {
        return state?.configuration?.valid === false
          && state?.sessionDiscovery?.status === 'configuration_error';
      }
      return state?.configuration?.valid === true
        && state?.sessionDiscovery?.status === 'ready'
        && state.panes.length === 2
        && state.panes.every((pane) => pane.started);
    },
    expectReady,
    { timeout },
  );

  return {
    electronApp,
    page,
    consoleMessages,
    configDirectory,
    launchEnvironment,
  };
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

async function disconnectPaneSocket(page, paneId) {
  await page.evaluate((targetPaneId) => window.neoncodeTest.disconnectPaneSocket(targetPaneId), paneId);
}

async function pressTerminalKey(page, paneId, key) {
  const paneIndex = paneIds.indexOf(paneId) + 1;
  const textarea = page.locator(`#terminal-${paneIndex} .xterm-helper-textarea`);
  await textarea.focus();
  await page.keyboard.press(key);
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

async function assertSecondInstanceDoesNotTouchConfig(instance) {
  const backupPath = path.join(instance.configDirectory, 'config.json.bak');
  const before = fs.statSync(backupPath);
  const child = spawn(electronExecutable, [appRoot], {
    cwd: appRoot,
    env: instance.launchEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('second Electron instance did not exit promptly'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert(exitCode === 0, `second Electron instance exited with ${exitCode}: ${stderr}`);
  const after = fs.statSync(backupPath);
  assert(after.mtimeMs === before.mtimeMs, 'second Electron instance touched configuration backup');
}

async function cleanupSessions(sessionPrefix, configDirectory) {
  let cleanupInstance;
  try {
    cleanupInstance = await launchApp(sessionPrefix, configDirectory);
    await killAllPanes(cleanupInstance);
  } catch (error) {
    log('cleanup.failed', { message: error.message });
  } finally {
    await closeInstance(cleanupInstance).catch(() => {});
  }
}

async function runFirstLaunchChecks(instance, sessionPrefix, runToken) {
  const { electronApp, page, configDirectory } = instance;
  const windowState = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      visible: window.isVisible(),
      contentSize: window.getContentSize(),
      webPreferences: window.webContents.getLastWebPreferences(),
      userData: app.getPath('userData'),
    };
  });
  assert(windowState.visible === false, 'test-mode Electron window should remain hidden');
  assert(windowState.webPreferences.contextIsolation === true, 'context isolation is not enabled');
  assert(windowState.webPreferences.nodeIntegration === false, 'renderer Node integration is enabled');
  assert(windowState.webPreferences.sandbox === true, 'renderer sandbox is not enabled');
  assert(
    path.resolve(windowState.userData).toLowerCase() === path.resolve(configDirectory).toLowerCase(),
    `unexpected Electron userData path: ${windowState.userData}`,
  );

  const rendererSecurity = await page.evaluate(async () => {
    const permission = await navigator.permissions.query({ name: 'notifications' });
    const opened = window.open('https://example.com');
    return {
      configDeepFrozen: Object.isFrozen(window.neoncodeDesktop.config)
        && Object.isFrozen(window.neoncodeDesktop.config.sessions)
        && Object.isFrozen(window.neoncodeDesktop.config.sessions[0].launchProfile),
      desktopKeys: Object.keys(window.neoncodeDesktop).sort(),
      nodeProcessType: typeof window.process,
      nodeRequireType: typeof window.require,
      openedWindow: Boolean(opened),
      permission: permission.state,
    };
  });
  assert(rendererSecurity.configDeepFrozen === true, 'preload bootstrap configuration is not deeply frozen');
  assert(rendererSecurity.nodeProcessType === 'undefined', 'renderer exposes Node process');
  assert(rendererSecurity.nodeRequireType === 'undefined', 'renderer exposes Node require');
  assert(rendererSecurity.openedWindow === false, 'renderer opened an external window');
  assert(rendererSecurity.permission === 'denied', `notification permission was ${rendererSecurity.permission}`);
  assert(
    JSON.stringify(rendererSecurity.desktopKeys) === JSON.stringify(['config', 'onPrepareClose', 'readClipboardText', 'writeClipboardText']),
    `unexpected preload API surface: ${rendererSecurity.desktopKeys.join(',')}`,
  );

  const windowCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert(windowCount === 1, `unexpected Electron window count after denied window.open: ${windowCount}`);
  await assertSecondInstanceDoesNotTouchConfig(instance);

  const initialState = await getState(page);
  log('state.first-launch', summarizeState(initialState));
  assert(initialState.configuration.valid === true, 'persisted configuration was not valid');
  assert(initialState.configuration.configStatus === 'loaded', `unexpected config status ${initialState.configuration.configStatus}`);
  assert(initialState.configuration.persistencePolicy === 'detach', 'configured close policy was not applied');
  assert(initialState.sessionDiscovery.sessionListEvents >= 1, 'startup did not list hub sessions');
  assert(
    !initialState.sessionDiscovery.sessions.some((sessionId) => sessionId.startsWith(`${sessionPrefix}-`)),
    'fresh test prefix unexpectedly found sessions',
  );

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
  assert(
    await page.getByTestId('pane-title-shell').textContent() === 'Configured Shell',
    'configured shell title was not rendered',
  );
  assert(
    await page.getByTestId('pane-title-tasks').textContent() === 'Configured Tasks',
    'configured tasks title was not rendered',
  );

  await verifyExecutedCommand(page, 'shell', 'shell-command', runToken);
  await verifyExecutedCommand(page, 'tasks', 'tasks-command', runToken);

  const cwdExpected = `cwd-/tmp-${runToken}`;
  const cwdCommand = `printf 'cwd-%s-%s\\n' "$PWD" '${runToken}'\n`;
  assertMarkerIsNotEchoed(cwdCommand, cwdExpected);
  await sendText(page, 'tasks', cwdCommand);
  await waitForOutput(page, 'tasks', cwdExpected);

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

  const ctrlDExpected = `ctrl-d-${runToken}`;
  const ctrlDCommand = `cat >/dev/null; printf 'ctrl-d-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(ctrlDCommand, ctrlDExpected);
  await sendText(page, 'shell', ctrlDCommand);
  await pressTerminalKey(page, 'shell', 'Control+d');
  await waitForOutput(page, 'shell', ctrlDExpected);

  const ctrlZExpected = `ctrl-z-${runToken}`;
  const ctrlZCommand = `sleep 30; printf 'ctrl-z-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(ctrlZCommand, ctrlZExpected);
  await sendText(page, 'shell', ctrlZCommand);
  await pressTerminalKey(page, 'shell', 'Control+z');
  await waitForOutput(page, 'shell', ctrlZExpected);
  await sendText(page, 'shell', "kill %1 2>/dev/null || true\n");

  const keyHex = [
    '1b4f41', '1b4f42', '1b4f43', '1b4f44',
    '1b4f48', '1b4f46', '1b5b357e', '1b5b367e',
    '1b4f50', '1b4f51', '1b5b31357e', '1b5b32347e', '0a',
  ].join('');
  const keyExpected = `keys-${keyHex}`;
  const keyCommand = `python3 -c "import os; d=b''.join(iter(lambda:os.read(0,1),b'\\n')); print('k'+'eys-'+(d+b'\\n').hex())"\n`;
  assertMarkerIsNotEchoed(keyCommand, 'keys-');
  await sendText(page, 'shell', keyCommand);
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F2', 'F5', 'F12', 'Enter']) {
    await pressTerminalKey(page, 'shell', key);
  }
  await waitForOutput(page, 'shell', 'keys-');
  const keyState = await getState(page);
  const keyOutput = keyState.panes.find((pane) => pane.paneId === 'shell').recentOutput;
  const actualKeyHex = [...keyOutput.matchAll(/keys-([0-9a-f]+)/g)].at(-1)?.[1];
  assert(actualKeyHex === keyHex, `terminal key bytes expected ${keyHex}, got ${actualKeyHex}`);

  const unicodeExpected = `unicode-λ-界-${runToken}`;
  const unicodePayload = Buffer.from(unicodeExpected).toString('base64');
  const unicodeCommand = `printf '%s' '${unicodePayload}' | base64 -d; printf '\\n'\n`;
  assertMarkerIsNotEchoed(unicodeCommand, unicodeExpected);
  await sendText(page, 'tasks', unicodeCommand);
  await waitForOutput(page, 'tasks', unicodeExpected);

  const previousClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  await page.evaluate(() => window.neoncodeTest.selectAll('tasks'));
  await pressTerminalKey(page, 'tasks', 'Control+Shift+c');
  await page.waitForFunction(
    async (expected) => (await window.neoncodeDesktop.readClipboardText()).includes(expected),
    unicodeExpected,
    { timeout },
  );
  await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);

  const heavyExpected = `heavy-done-${runToken}`;
  const heavyCommand = `i=0; while [ $i -lt 2000 ]; do printf 'load-%04d\\n' "$i"; i=$((i+1)); done; printf 'heavy-done-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(heavyCommand, heavyExpected);
  await sendText(page, 'tasks', heavyCommand);
  await waitForOutput(page, 'tasks', heavyExpected);

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

  if (tmuxResult.includes('present')) {
    const tmuxSession = `neoncode-${runToken}`;
    const tmuxSocket = `neoncode-${runToken}`;
    await sendText(page, 'tasks', `tmux -f /dev/null -L '${tmuxSocket}' new-session -s '${tmuxSession}'\n`);
    await page.waitForTimeout(500);
    const tmuxLiveExpected = `tmux-live-${runToken}`;
    const tmuxLiveCommand = `printf 'tmux-live-%s\\n' '${runToken}'\n`;
    assertMarkerIsNotEchoed(tmuxLiveCommand, tmuxLiveExpected);
    await sendText(page, 'tasks', tmuxLiveCommand);
    await waitForOutput(page, 'tasks', tmuxLiveExpected);
    await sendText(page, 'tasks', '\x02d');
    await page.waitForTimeout(300);
    const tmuxDetachedExpected = `tmux-detached-${runToken}`;
    const tmuxDetachedCommand = `printf 'tmux-detached-%s\\n' '${runToken}'\n`;
    assertMarkerIsNotEchoed(tmuxDetachedCommand, tmuxDetachedExpected);
    await sendText(page, 'tasks', tmuxDetachedCommand);
    await waitForOutput(page, 'tasks', tmuxDetachedExpected);
    await sendText(page, 'tasks', `tmux -L '${tmuxSocket}' kill-session -t '${tmuxSession}'\n`);
  }

  if (nvimResult.includes('present')) {
    const nvimPath = `/tmp/neoncode-nvim-${runToken}.txt`;
    const nvimContent = `editor-${runToken}`;
    await sendText(page, 'tasks', `nvim -u NONE -n '${nvimPath}'\n`);
    await page.waitForTimeout(500);
    await sendText(page, 'tasks', `i${nvimContent}`);
    await sendText(page, 'tasks', '\x1b:w!\n:qa!\n');
    await page.waitForTimeout(500);
    const nvimExpected = `nvim-file-${nvimContent}`;
    const nvimVerifyCommand = `printf 'nvim-file-'; cat '${nvimPath}'; printf '\\n'; rm -f '${nvimPath}'\n`;
    assertMarkerIsNotEchoed(nvimVerifyCommand, nvimExpected);
    await sendText(page, 'tasks', nvimVerifyCommand);
    await waitForOutput(page, 'tasks', nvimExpected);
  }

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

  const beforeReconnect = await getState(page);
  const beforeReconnectEvents = beforeReconnect.panes.find((pane) => pane.paneId === 'shell').reconnectEvents;
  await disconnectPaneSocket(page, 'shell');
  await page.waitForFunction(
    ({ previousEvents }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === 'shell');
      return pane?.lifecycle === 'attached' && pane.reconnectEvents > previousEvents;
    },
    { previousEvents: beforeReconnectEvents },
    { timeout },
  );
  const reconnectExpected = `reconnected-${runToken}`;
  const reconnectCommand = `printf 'reconnected-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(reconnectCommand, reconnectExpected);
  await sendText(page, 'shell', reconnectCommand);
  await waitForOutput(page, 'shell', reconnectExpected);

  log('tools', { tmux: tmuxResult, nvim: nvimResult });
}

async function runSecondLaunchChecks(instance, sessionPrefix, runToken) {
  const restoredWindowSize = await instance.electronApp.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0].getContentSize()
  ));
  assert(
    restoredWindowSize[0] === 1400 && restoredWindowSize[1] === 900,
    `window size was not restored: ${restoredWindowSize.join('x')}`,
  );

  const seedExpected = `seed-${runToken}`;
  await waitForOutput(instance.page, 'shell', seedExpected);

  const state = await getState(instance.page);
  log('state.second-launch', summarizeState(state));
  assert(state.configuration.configStatus === 'recovered', `expected recovered config, got ${state.configuration.configStatus}`);
  assert(
    state.configuration.warnings.some((warning) => warning.includes('restored from config.json.bak')),
    'configuration recovery warning was not exposed',
  );
  assert(
    await instance.page.getByTestId('configuration-status').getAttribute('data-state') === 'warning',
    'configuration recovery warning was not visible',
  );
  const expectedSessionIds = [`${sessionPrefix}-shell`, `${sessionPrefix}-tasks`];
  for (const sessionId of expectedSessionIds) {
    assert(
      state.sessionDiscovery.sessions.includes(sessionId),
      `session discovery did not find persisted session ${sessionId}`,
    );
  }
  await assertPaneLifecycles(instance, 'attached');
  for (const pane of state.panes) {
    assert(pane.firstOutputSeq > 0, `${pane.paneId} did not receive replayed output sequence data`);
    assert(pane.lastOutputSeq >= pane.firstOutputSeq, `${pane.paneId} output sequence regressed`);
    assert(pane.outputGap === '', `${pane.paneId} output sequence gap: ${pane.outputGap}`);
  }
  assert(
    state.panes.find((pane) => pane.paneId === 'shell').recentOutput.includes(seedExpected),
    'pre-close shell output was not replayed after attach',
  );

  const restoredExpected = `restored-${runToken}`;
  const restoredCommand = `printf 'restored-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(restoredCommand, restoredExpected);
  await sendText(instance.page, 'shell', restoredCommand);
  await waitForOutput(instance.page, 'shell', restoredExpected);
}

async function runKillPolicyCheck(runToken) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-kill-policy-'));
  const sessionPrefix = `kill-policy-${runToken}`;
  let instance;
  try {
    writeTestConfig(directory, { persistencePolicy: 'kill' });
    instance = await launchApp(sessionPrefix, directory);
    const firstState = await getState(instance.page);
    assert(firstState.configuration.persistencePolicy === 'kill', 'kill close policy was not loaded');
    await closeInstance(instance);
    instance = undefined;

    instance = await launchApp(sessionPrefix, directory);
    const secondState = await getState(instance.page);
    assert(
      !secondState.sessionDiscovery.sessions.some((sessionId) => sessionId.startsWith(`${sessionPrefix}-`)),
      'kill close policy left sessions running after window close',
    );
    await assertPaneLifecycles(instance, 'started');
    await killAllPanes(instance);
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runInvalidConfigurationCheck(runToken) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-invalid-config-'));
  let instance;
  try {
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      unexpected: true,
    }));
    instance = await launchApp(`invalid-${runToken}`, directory, { expectReady: false });
    const state = await getState(instance.page);
    assert(state.configuration.valid === false, 'invalid configuration was accepted');
    assert(state.configuration.errors.length > 0, 'invalid configuration error was not exposed');
    assert(state.panes.length === 0, 'invalid configuration launched terminal panes');
    assert(state.sessionDiscovery.sessionListEvents === 0, 'invalid configuration connected to the hub');
    assert(
      await instance.page.getByTestId('configuration-status').getAttribute('data-state') === 'error',
      'invalid configuration was not visibly reported',
    );
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  log('launch', { appRoot, endpoint });
  const runToken = `${Date.now()}`;
  const sessionPrefix = `electron-playwright-${runToken}`;
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-electron-config-'));
  writeTestConfig(configDirectory);
  let instance;
  let sessionsCleaned = false;

  try {
    instance = await launchApp(sessionPrefix, configDirectory);
    await runFirstLaunchChecks(instance, sessionPrefix, runToken);
    await closeInstance(instance);
    instance = undefined;

    const persistedState = JSON.parse(fs.readFileSync(path.join(configDirectory, 'state.json'), 'utf8'));
    assert(
      persistedState.window.width === 1400 && persistedState.window.height === 900,
      `window state was not persisted: ${JSON.stringify(persistedState.window)}`,
    );
    fs.writeFileSync(path.join(configDirectory, 'config.json'), '{ intentionally invalid');

    instance = await launchApp(sessionPrefix, configDirectory);
    await runSecondLaunchChecks(instance, sessionPrefix, runToken);
    await killAllPanes(instance);
    sessionsCleaned = true;

    const finalState = await getState(instance.page);
    log('state.final', summarizeState(finalState));
    await closeInstance(instance);
    instance = undefined;
    await runKillPolicyCheck(runToken);
    await runInvalidConfigurationCheck(runToken);
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
      await cleanupSessions(sessionPrefix, configDirectory);
    }
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
