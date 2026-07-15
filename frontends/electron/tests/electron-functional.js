const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const electronExecutable = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig } = require('../config-store');

const appRoot = path.resolve(__dirname, '..', '..');
const endpoint = process.env.NEONCODE_HUB_ENDPOINT || 'ws://127.0.0.1:44777/ws';
const timeout = Number.parseInt(process.env.NEONCODE_PLAYWRIGHT_TIMEOUT || '20000', 10);
function writeTestConfig(directory, { persistencePolicy = 'detach' } = {}) {
  const config = defaultConfig();
  config.sessionPrefix = 'config-file-prefix';
  config.persistence.onWindowClose = persistencePolicy;
  config.terminal.fontFamily = 'Consolas, monospace';
  config.terminal.fontSize = 16;
  config.terminal.cursorBlink = false;
  config.terminal.theme.background = '#101820';
  config.launchProfiles['tasks-in-tmp'] = {
    type: 'process', command: 'bash', args: [], cwd: '/tmp',
  };
  config.workspaces = [
    {
      id: 'default',
      name: 'Development',
      layout: { columns: 2 },
      sessions: [
        { id: 'shell', title: 'Configured Shell', launchProfile: 'default-shell' },
        { id: 'tasks', title: 'Configured Tasks', launchProfile: 'tasks-in-tmp' },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      layout: { columns: 2 },
      sessions: [
        { id: 'review-shell', title: 'Review Shell', launchProfile: 'default-shell' },
        { id: 'review-tasks', title: 'Review Tasks', launchProfile: 'tasks-in-tmp' },
        { id: 'review-agent', title: 'Review Agent', launchProfile: 'default-shell' },
      ],
    },
  ];
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
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
  try {
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
          && state.panes.length > 0
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
  } catch (error) {
    await electronApp.close().catch(() => {});
    throw error;
  }
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
  const textarea = page.getByTestId(`terminal-${paneId}`).locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press(key);
}

async function terminalPoint(page, paneId, { xFraction = 0.5, yFraction = 0.5 } = {}) {
  const screen = page.getByTestId(`terminal-${paneId}`).locator('.xterm-screen');
  const box = await screen.boundingBox();
  assert(box, `xterm screen has no bounding box for ${paneId}`);
  return {
    x: box.x + box.width * xFraction,
    y: box.y + box.height * yFraction,
  };
}

async function terminalCellPoint(page, paneId, row, column) {
  const pane = (await getState(page)).panes.find((candidate) => candidate.paneId === paneId);
  assert(pane, `missing terminal state for ${paneId}`);
  assert(row >= 1 && row <= pane.rows, `terminal row ${row} is outside ${paneId}`);
  assert(column >= 1 && column <= pane.cols, `terminal column ${column} is outside ${paneId}`);
  return terminalPoint(page, paneId, {
    xFraction: (column - 0.5) / pane.cols,
    yFraction: (row - 0.5) / pane.rows,
  });
}

async function clickTerminal(page, paneId, options) {
  const point = await terminalPoint(page, paneId, options);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function verifyMouseReporting(page, paneId, token) {
  const ready = `mouse-ready-${token}`;
  const script = [
    'import os, termios, tty',
    'fd = 0',
    'old = termios.tcgetattr(fd)',
    `print('${ready}', flush=True)`,
    'tty.setraw(fd)',
    "os.write(1, b'\\x1b[?1000h\\x1b[?1006h')",
    "data = b''",
    "while not data.endswith(b'm'):",
    '    data += os.read(fd, 1)',
    "os.write(1, b'\\x1b[?1000l\\x1b[?1006l')",
    'termios.tcsetattr(fd, termios.TCSADRAIN, old)',
    "print('\\n' + 'mouse-bytes-' + data.hex(), flush=True)",
  ].join('\n');
  const encoded = Buffer.from(script).toString('base64');
  const command = `python3 -c "$(printf '%s' '${encoded}' | base64 -d)"\n`;
  assertMarkerIsNotEchoed(command, ready);
  await sendText(page, paneId, command);
  await waitForOutput(page, paneId, ready);

  await clickTerminal(page, paneId);
  await waitForOutput(page, paneId, 'mouse-bytes-');

  const state = await getState(page);
  const output = state.panes.find((pane) => pane.paneId === paneId).recentOutput;
  const hex = [...output.matchAll(/mouse-bytes-([0-9a-f]+)/g)].at(-1)?.[1];
  assert(hex, 'mouse report bytes were not captured');
  const report = Buffer.from(hex, 'hex').toString('binary');
  assert(
    /^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/.test(report),
    `unexpected SGR mouse report: ${JSON.stringify(report)}`,
  );
}

async function verifyTmuxMouseBehavior(page, paneId, token) {
  const leftClickExpected = `tmux-click-0-${token}`;
  await clickTerminal(page, paneId, { xFraction: 0.25, yFraction: 0.35 });
  const clickCommand = `v=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_index}'); printf 'tmux-click-%s-%s\\n' "$v" '${token}'\n`;
  assertMarkerIsNotEchoed(clickCommand, leftClickExpected);
  await sendText(page, paneId, clickCommand);
  await waitForOutput(page, paneId, leftClickExpected);
  // The marker can arrive just before tmux redraws the shell prompt. Avoid
  // merging the following long command into that redraw/input transition.
  await page.waitForTimeout(500);

  const resultPath = `/tmp/neoncode-tmux-wheel-${token}`;
  const historyExpected = `tmux-history-${token}`;
  const historyCommand = `rm -f '${resultPath}'; (j=0; while [ "$(tmux display-message -p -t "$TMUX_PANE" '#{pane_in_mode}')" != 1 ] && [ $j -lt 100 ]; do sleep 0.05; j=$((j+1)); done; [ "$(tmux display-message -p -t "$TMUX_PANE" '#{pane_in_mode}')" = 1 ] && printf 1 > '${resultPath}') & i=0; while [ $i -lt 120 ]; do printf 'tmux-line-%03d\\n' "$i"; i=$((i+1)); done; printf 'tmux-history-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(historyCommand, historyExpected);
  await sendText(page, paneId, historyCommand);
  await waitForOutput(page, paneId, historyExpected);

  const leftPoint = await terminalPoint(page, paneId, { xFraction: 0.25, yFraction: 0.35 });
  await page.mouse.move(leftPoint.x, leftPoint.y);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1000);
  await sendText(page, paneId, 'q');
  await page.waitForTimeout(100);
  await sendText(page, paneId, '\x03');

  const wheelExpected = `tmux-wheel-1-${token}`;
  const wheelCommand = `printf 'tmux-wheel-'; cat '${resultPath}'; printf -- '-%s\\n' '${token}'; rm -f '${resultPath}'\n`;
  assertMarkerIsNotEchoed(wheelCommand, wheelExpected);
  await sendText(page, paneId, wheelCommand);
  await waitForOutput(page, paneId, wheelExpected);
}

async function verifyNeovimMouseBehavior(page, paneId, token) {
  const sourcePath = `/tmp/neoncode-nvim-mouse-${token}.txt`;
  const resultPath = `/tmp/neoncode-nvim-mouse-result-${token}.txt`;
  const ready = `nvim-mouse-ready-${token}`;
  const launchCommand = `seq -f 'line-%02g' 1 80 > '${sourcePath}'; printf 'nvim-mouse-ready-%s\\n' '${token}'; nvim -u NONE -n -c 'set mouse=a laststatus=0 noshowmode noruler' '${sourcePath}'\n`;
  assertMarkerIsNotEchoed(launchCommand, ready);
  await sendText(page, paneId, launchCommand);
  await waitForOutput(page, paneId, ready);
  await page.waitForTimeout(500);

  const targetRow = 7;
  const point = await terminalCellPoint(page, paneId, targetRow, 6);
  await page.mouse.click(point.x, point.y);
  await sendText(page, paneId, `\x1b:call writefile([string(line('.'))], '${resultPath}')\n`);
  await page.waitForTimeout(100);

  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(200);
  await sendText(page, paneId, `\x1b:call writefile([string(line('w0'))], '${resultPath}', 'a')\n:qa!\n`);
  await page.waitForTimeout(300);

  const resultPrefix = 'nvim-mouse-result-';
  const resultExpected = `${resultPrefix}${targetRow}`;
  const verifyCommand = `printf '${resultPrefix}'; cat '${resultPath}'; rm -f '${sourcePath}' '${resultPath}'\n`;
  assertMarkerIsNotEchoed(verifyCommand, resultExpected);
  await sendText(page, paneId, verifyCommand);
  await waitForOutput(page, paneId, resultExpected);

  const output = (await getState(page)).panes.find((pane) => pane.paneId === paneId).recentOutput;
  const result = [...output.matchAll(/nvim-mouse-result-(\d+)\r?\n(\d+)/g)].at(-1);
  assert(result, 'Neovim mouse result was not captured');
  const clickedLine = Number.parseInt(result[1], 10);
  const viewportTop = Number.parseInt(result[2], 10);
  assert(clickedLine === targetRow, `Neovim click selected line ${clickedLine}, expected ${targetRow}`);
  assert(viewportTop > 1, `Neovim wheel did not scroll the viewport: top line ${viewportTop}`);
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

async function verifyKeyboardPaste(instance, paneId, shortcut, label, token) {
  const expected = `${label}-${token}`;
  const command = `printf '${label}-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(command, expected);
  const previousClipboard = await instance.electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const before = await getState(instance.page);
  const beforeInputs = before.panes.find((pane) => pane.paneId === paneId).inputEvents;
  try {
    await instance.electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), command);
    await instance.page.evaluate(
      ({ targetPaneId, text }) => window.neoncodeTest.simulatePasteShortcutRace(targetPaneId, text),
      { targetPaneId: paneId, text: command },
    );
    await waitForOutput(instance.page, paneId, expected);
    const after = await getState(instance.page);
    const afterInputs = after.panes.find((pane) => pane.paneId === paneId).inputEvents;
    assert(afterInputs === beforeInputs + 1, `${shortcut} pasted ${afterInputs - beforeInputs} times in ${paneId}`);
  } finally {
    await instance.electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
  }
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

async function assertWorkspaceStatus(page, workspaceId, expectedState, expectedText) {
  const status = page.getByTestId(`workspace-status-${workspaceId}`);
  assert(
    await status.getAttribute('data-state') === expectedState,
    `${workspaceId} workspace status was not ${expectedState}`,
  );
  assert(
    await status.textContent() === expectedText,
    `${workspaceId} workspace status expected '${expectedText}', got '${await status.textContent()}'`,
  );
}

async function switchWorkspace(page, workspaceId) {
  await page.evaluate((targetWorkspaceId) => window.neoncodeTest.switchWorkspace(targetWorkspaceId), workspaceId);
  await page.waitForFunction(
    (targetWorkspaceId) => {
      const state = window.neoncodeTest.getState();
      return state.workspace.activeWorkspaceId === targetWorkspaceId
        && state.panes.length > 0
        && state.panes.every((pane) => pane.started);
    },
    workspaceId,
    { timeout },
  );
}

async function killAllPanes(instance) {
  const targets = (await getState(instance.page)).panes.map((pane) => pane.paneId);
  await instance.page.evaluate(async (paneIds) => {
    await Promise.all(paneIds.map((paneId) => window.neoncodeTest.killPane(paneId)));
  }, targets);
  const state = await getState(instance.page);
  assert(state.panes.every((pane) => pane.lifecycle === 'killed'), 'test sessions were not killed');
}

async function killAllWorkspaces(instance) {
  const workspaceIds = (await getState(instance.page)).configuration.workspaces.map((workspace) => workspace.id);
  for (const workspaceId of workspaceIds) {
    const state = await getState(instance.page);
    if (state.workspace.activeWorkspaceId !== workspaceId) {
      await switchWorkspace(instance.page, workspaceId);
    }
    await killAllPanes(instance);
  }
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
  const secondInstanceEnvironment = { ...instance.launchEnvironment };
  delete secondInstanceEnvironment.NODE_OPTIONS;
  const child = spawn(electronExecutable, [appRoot], {
    cwd: appRoot,
    env: secondInstanceEnvironment,
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
    await killAllWorkspaces(cleanupInstance);
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
        && Object.isFrozen(window.neoncodeDesktop.config.workspaces)
        && Object.isFrozen(window.neoncodeDesktop.config.workspaces[0].sessions[0].launchProfile),
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
    JSON.stringify(rendererSecurity.desktopKeys) === JSON.stringify(['config', 'onPrepareClose', 'readClipboardText', 'setActiveWorkspace', 'writeClipboardText']),
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
  assert(initialState.workspace.activeWorkspaceId === 'default', 'default workspace was not activated');
  assert(initialState.configuration.workspaces.length === 2, 'configured workspaces were not exposed');
  assert(await page.getByTestId('workspace-list').getByRole('button').count() === 2, 'workspace selector was not rendered');
  assert(
    await page.getByTestId('workspace-default').getAttribute('aria-current') === 'true',
    'default workspace was not visibly selected',
  );
  await assertWorkspaceStatus(page, 'default', 'running', '2 running');
  await assertWorkspaceStatus(page, 'review', 'idle', 'Not started');
  const initialLocation = page.getByTestId('workspace-default').locator('.workspace-location');
  assert(await initialLocation.textContent() === 'WSL · 2 paths', 'workspace location summary was not rendered');
  assert(await initialLocation.getAttribute('data-source') === 'hub', 'started workspace location was not hub-backed');
  assert(initialState.configuration.terminal.fontSize === 16, 'configured terminal appearance was not exposed');
  for (const pane of initialState.panes) {
    assert(pane.fontFamily === 'Consolas, monospace', `${pane.paneId} font family was not applied`);
    assert(pane.fontSize === 16, `${pane.paneId} font size was not applied`);
    assert(pane.cursorBlink === false, `${pane.paneId} cursor blink was not applied`);
    assert(pane.background === '#101820', `${pane.paneId} background was not applied`);
    assert(pane.magenta === '#881798', `${pane.paneId} purple color was not mapped to xterm magenta`);
    assert(pane.brightMagenta === '#b4009e', `${pane.paneId} brightPurple was not mapped to xterm brightMagenta`);
  }
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
  await verifyKeyboardPaste(instance, 'shell', 'Control+Shift+v', 'shortcut-paste-shell', runToken);
  await verifyKeyboardPaste(instance, 'tasks', 'Shift+Insert', 'shortcut-paste-tasks', runToken);

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
  const jobCleanupExpected = `job-cleanup-${runToken}`;
  const jobCleanupCommand = `kill %1 2>/dev/null || true; printf 'job-cleanup-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(jobCleanupCommand, jobCleanupExpected);
  await sendText(page, 'shell', jobCleanupCommand);
  await waitForOutput(page, 'shell', jobCleanupExpected);
  await page.waitForTimeout(200);

  const keyHex = [
    '1b5b41', '1b5b42', '1b5b43', '1b5b44',
    '1b5b48', '1b5b46', '1b5b357e', '1b5b367e',
    '1b4f50', '1b4f51', '1b5b31357e', '1b5b32347e', '0a',
  ].join('');
  const keyExpected = `keys-${keyHex}`;
  const keyReaderReady = `key-reader-ready-${runToken}`;
  const keyCommand = `python3 -c "import os; print('key-reader-'+'ready-'+'${runToken}',flush=True); d=b''.join(iter(lambda:os.read(0,1),b'\\n')); print('k'+'eys-'+(d+b'\\n').hex())"\n`;
  assertMarkerIsNotEchoed(keyCommand, keyReaderReady);
  assertMarkerIsNotEchoed(keyCommand, 'keys-');
  await sendText(page, 'shell', keyCommand);
  await waitForOutput(page, 'shell', keyReaderReady);
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

  await verifyMouseReporting(page, 'tasks', runToken);

  const heavyExpected = `heavy-done-${runToken}`;
  const heavyCommand = `i=0; while [ $i -lt 20000 ]; do printf 'load-%05d\\n' "$i"; i=$((i+1)); done; printf 'heavy-done-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(heavyCommand, heavyExpected);
  const heavyStarted = Date.now();
  await sendText(page, 'tasks', heavyCommand);
  await waitForOutput(page, 'tasks', heavyExpected);
  assert(Date.now() - heavyStarted < 30000, '20,000-line output soak exceeded 30 seconds');
  const heavyState = await getState(page);
  assert(
    heavyState.panes.find((pane) => pane.paneId === 'tasks').outputGap === '',
    '20,000-line output soak produced a sequence gap',
  );

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
    await sendText(page, 'tasks', "tmux set-option -g mouse on; tmux split-window -h; tmux select-pane -t ':0.1'\n");
    await page.waitForTimeout(300);
    await verifyTmuxMouseBehavior(page, 'tasks', runToken);
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
    await verifyNeovimMouseBehavior(page, 'tasks', runToken);
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
  const beforeReconnectPane = beforeReconnect.panes.find((pane) => pane.paneId === 'shell');
  const beforeReconnectEvents = beforeReconnectPane.reconnectEvents;
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
  const afterReconnectPane = (await getState(page)).panes.find((pane) => pane.paneId === 'shell');
  assert(afterReconnectPane.sessionInstanceId === beforeReconnectPane.sessionInstanceId, 'reconnect changed session incarnation');
  assert(afterReconnectPane.replayResetEvents === 0, 'same-session reconnect reset terminal replay');
  assert(afterReconnectPane.replayTruncated === false, 'same-session reconnect reported truncated replay');

  await switchWorkspace(page, 'review');
  let workspaceState = await getState(page);
  assert(workspaceState.panes.length === 3, 'three-pane workspace did not render all panes');
  assert(await page.getByTestId('terminal-grid').locator('.terminal-pane').count() === 3, 'dynamic pane DOM count was not three');
  assert(
    await page.getByTestId('workspace-review').getAttribute('aria-current') === 'true',
    'review workspace was not visibly selected',
  );
  await assertWorkspaceStatus(page, 'default', 'detached', '2 detached');
  await assertWorkspaceStatus(page, 'review', 'running', '3 running');
  const reviewSeedExpected = `review-seed-${runToken}`;
  const reviewSeedCommand = `export NEONCODE_REVIEW_PERSIST='${runToken}'; printf 'review-seed-%s\\n' "$NEONCODE_REVIEW_PERSIST"\n`;
  assertMarkerIsNotEchoed(reviewSeedCommand, reviewSeedExpected);
  await sendText(page, 'review-shell', reviewSeedCommand);
  await waitForOutput(page, 'review-shell', reviewSeedExpected);

  await switchWorkspace(page, 'default');
  workspaceState = await getState(page);
  await assertWorkspaceStatus(page, 'default', 'running', '2 running');
  await assertWorkspaceStatus(page, 'review', 'detached', '3 detached');
  assert(workspaceState.panes.length === 2, 'default workspace did not restore two panes');
  await assertPaneLifecycles(instance, 'attached');
  const switchedBackExpected = `workspace-return-${runToken}`;
  const switchedBackCommand = `printf 'workspace-return-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(switchedBackCommand, switchedBackExpected);
  await sendText(page, 'shell', switchedBackCommand);
  await waitForOutput(page, 'shell', switchedBackExpected);

  await switchWorkspace(page, 'review');
  await assertPaneLifecycles(instance, 'attached');
  const reviewReturnExpected = `review-return-${runToken}`;
  const reviewReturnCommand = `printf 'review-return-%s\\n' "$NEONCODE_REVIEW_PERSIST"\n`;
  assertMarkerIsNotEchoed(reviewReturnCommand, reviewReturnExpected);
  await sendText(page, 'review-shell', reviewReturnCommand);
  await waitForOutput(page, 'review-shell', reviewReturnExpected);

  await sendText(page, 'review-agent', 'exit 7\n');
  await page.waitForFunction(() => {
    const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === 'review-agent');
    return pane?.lifecycle === 'exited'
      && pane.latestExit?.status === 7
      && pane.latestExit?.reason === 'process_exit';
  }, null, { timeout });
  await assertWorkspaceStatus(page, 'review', 'attention', 'Needs attention');
  assert(
    await page.getByTestId('workspace-acknowledge-review').isVisible(),
    'workspace attention acknowledgement was not visible',
  );

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

  const reviewSeedExpected = `review-seed-${runToken}`;
  await waitForOutput(instance.page, 'review-shell', reviewSeedExpected);

  let state = await getState(instance.page);
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
  assert(state.workspace.activeWorkspaceId === 'review', 'persisted active workspace was not restored');
  assert(state.panes.length === 3, 'restored review workspace did not contain three panes');
  const summaries = state.sessionDiscovery.sessionSummaries;
  assert(summaries.length === 5, `expected five hub session summaries, got ${summaries.length}`);
  for (const summary of summaries) {
    assert(summary.metadataComplete === true, `${summary.sessionId} metadata was incomplete`);
    assert(summary.lifecycleComplete === true, `${summary.sessionId} lifecycle metadata was incomplete`);
    assert(summary.instanceComplete === true, `${summary.sessionId} instance metadata was incomplete`);
    assert(/^[0-9a-f]{32}$/.test(summary.instanceId), `${summary.sessionId} instance id was invalid`);
    assert(summary.command === 'bash', `${summary.sessionId} command metadata was not bash`);
    assert(summary.persistent === true, `${summary.sessionId} was not reported persistent`);
    assert(summary.attachmentCount === 0, `${summary.sessionId} was unexpectedly attached during discovery`);
  }
  const agentSummary = summaries.find((summary) => summary.sessionId === `${sessionPrefix}-review-agent`);
  assert(agentSummary.state === 'exited', 'exited review agent was not retained by the hub');
  assert(agentSummary.latestExit?.status === 7, 'retained review agent exit status was not 7');
  assert(agentSummary.latestExit?.reason === 'process_exit', 'retained review agent exit reason was incorrect');
  assert(
    summaries.find((summary) => summary.sessionId === `${sessionPrefix}-shell`).cwd === null,
    'hub did not preserve the original default cwd metadata',
  );
  assert(
    state.configuration.workspaces[0].sessions[0].launchProfile.cwd === '/changed-after-start',
    'recovered frontend configuration did not contain the changed cwd',
  );
  const restoredLocation = instance.page.getByTestId('workspace-default').locator('.workspace-location');
  assert(await restoredLocation.getAttribute('data-source') === 'hub', 'restored workspace location was not hub-backed');
  await assertWorkspaceStatus(instance.page, 'default', 'available', '2 available');
  await assertWorkspaceStatus(instance.page, 'review', 'attention', 'Needs attention');
  const expectedSessionIds = [
    `${sessionPrefix}-shell`, `${sessionPrefix}-tasks`,
    `${sessionPrefix}-review-shell`, `${sessionPrefix}-review-tasks`, `${sessionPrefix}-review-agent`,
  ];
  for (const sessionId of expectedSessionIds) {
    assert(
      state.sessionDiscovery.sessions.includes(sessionId),
      `session discovery did not find persisted session ${sessionId}`,
    );
  }
  for (const pane of state.panes) {
    const expectedLifecycle = pane.paneId === 'review-agent' ? 'started' : 'attached';
    assert(pane.lifecycle === expectedLifecycle, `${pane.paneId} expected ${expectedLifecycle}, got ${pane.lifecycle}`);
  }
  await instance.page.getByTestId('workspace-acknowledge-review').click();
  await instance.page.waitForFunction(() => (
    document.querySelector('[data-testid="workspace-status-review"]')?.dataset.state === 'running'
  ), null, { timeout });
  await assertWorkspaceStatus(instance.page, 'review', 'running', '3 running');
  await instance.page.waitForFunction(() => (
    window.neoncodeTest.getState().workspace.summaries
      .find((workspace) => workspace.id === 'review')?.state === 'running'
  ), null, { timeout });
  assert(
    await instance.page.getByTestId('workspace-acknowledge-review').isHidden(),
    'workspace attention acknowledgement did not clear',
  );
  for (const pane of state.panes) {
    if (pane.activationMode === 'attach') {
      assert(pane.firstOutputSeq > 0, `${pane.paneId} did not receive replayed output sequence data`);
    }
    if (pane.outputEvents > 0) {
      assert(pane.lastOutputSeq >= pane.firstOutputSeq, `${pane.paneId} output sequence regressed`);
    }
    assert(pane.outputGap === '', `${pane.paneId} output sequence gap: ${pane.outputGap}`);
  }
  assert(
    state.panes.find((pane) => pane.paneId === 'review-shell').recentOutput.includes(reviewSeedExpected),
    'active review workspace output was not replayed after relaunch',
  );

  await switchWorkspace(instance.page, 'default');
  state = await getState(instance.page);
  await assertWorkspaceStatus(instance.page, 'default', 'running', '2 running');
  await assertWorkspaceStatus(instance.page, 'review', 'detached', '3 detached');
  await assertPaneLifecycles(instance, 'attached');
  const seedExpected = `seed-${runToken}`;
  assert(
    state.panes.find((pane) => pane.paneId === 'shell').recentOutput.includes(seedExpected),
    'inactive default workspace output was not replayed after switching back',
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
    await switchWorkspace(instance.page, 'review');
    assert((await getState(instance.page)).panes.length === 3, 'kill test did not visit the second workspace');
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
    assert(persistedState.schemaVersion === 2, 'workspace state schema was not persisted');
    assert(persistedState.activeWorkspaceId === 'review', 'active workspace was not persisted');
    const configBackupPath = path.join(configDirectory, 'config.json.bak');
    const changedBackup = JSON.parse(fs.readFileSync(configBackupPath, 'utf8'));
    changedBackup.launchProfiles['default-shell'].cwd = '/changed-after-start';
    fs.writeFileSync(configBackupPath, `${JSON.stringify(changedBackup, null, 2)}\n`);
    fs.writeFileSync(path.join(configDirectory, 'config.json'), '{ intentionally invalid');

    instance = await launchApp(sessionPrefix, configDirectory);
    await runSecondLaunchChecks(instance, sessionPrefix, runToken);
    await killAllWorkspaces(instance);
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
          await killAllWorkspaces(instance);
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
