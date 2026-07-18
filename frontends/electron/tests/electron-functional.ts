import { spawn } from 'node:child_process';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from 'playwright';

import { defaultConfig } from '../config-store';
import type {
  DesktopConfig,
  DesktopLaunchProfile,
  NeoncodeDesktopApi,
  PublicConfiguration,
  PublicPaneState,
  RendererPublicState,
  RendererTestApi,
  SessionLifecycle,
  TerminalAppearance,
} from '../shared/types';

const electronExecutable: unknown = require('electron');

interface FunctionalConfiguration extends PublicConfiguration {
  terminal: TerminalAppearance;
  workspaces: Array<{
    id: string;
    name: string;
    sessions: Array<{ launchProfile: DesktopLaunchProfile }>;
  }>;
}

interface FunctionalState extends Omit<RendererPublicState, 'configuration'> {
  configuration: FunctionalConfiguration;
}

interface ElectronTestInstance {
  electronApp: ElectronApplication;
  page: Page;
  consoleMessages: string[];
  configDirectory: string;
  launchEnvironment: NodeJS.ProcessEnv;
}

interface LaunchOptions {
  expectReady?: boolean;
}

interface TerminalPointOptions {
  xFraction?: number;
  yFraction?: number;
}

interface TestConfigOptions {
  persistencePolicy?: 'detach' | 'kill';
}

interface PersistedTestState {
  schemaVersion: number;
  window: { width: number; height: number };
  activeWorkspaceId: string | null;
  workspaceLayouts: Record<string, unknown>;
}

declare global {
  interface Window {
    neoncodeDesktop: NeoncodeDesktopApi & { readonly config: DesktopConfig };
    neoncodeTest: RendererTestApi;
  }
}

const appRoot = path.resolve(__dirname, '..', '..');
const endpoint = process.env.NEONCODE_HUB_ENDPOINT || 'ws://127.0.0.1:44777/ws';
const timeout = Number.parseInt(process.env.NEONCODE_PLAYWRIGHT_TIMEOUT || '20000', 10);
const electronTestSuite = process.env.NEONCODE_ELECTRON_TEST_SUITE === 'headless' ? 'headless' : 'gui';
const runGuiOnlyChecks = electronTestSuite === 'gui';

function writeTestConfig(
  directory: string,
  { persistencePolicy = 'detach' }: TestConfigOptions = {},
): void {
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
      path: null,
      defaultLaunchProfile: 'default-shell',
      layout: { columns: 2 },
      sessions: [
        { id: 'shell', title: 'Configured Shell', launchProfile: 'default-shell' },
        { id: 'tasks', title: 'Configured Tasks', launchProfile: 'tasks-in-tmp' },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      path: null,
      defaultLaunchProfile: 'default-shell',
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

function log(message: string, details?: unknown): void {
  const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[electron-test] ${message}${payload}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireElectronExecutable(value: unknown): string {
  assert(typeof value === 'string', 'Electron module did not resolve to an executable path');
  return value;
}

function parseJson<T>(text: string, label: string): T {
  const value: unknown = JSON.parse(text);
  assert(value !== null && typeof value === 'object', `${label} must contain a JSON object`);
  return value as T;
}

function summarizeState(state: FunctionalState) {
  return {
    configuration: state.configuration,
    panes: state.panes.map(({ recentOutput, ...pane }) => ({
      ...pane,
      recentOutputChars: recentOutput.length,
    })),
    sessionDiscovery: state.sessionDiscovery,
  };
}

async function launchApp(
  sessionPrefix: string,
  configDirectory: string,
  { expectReady = true }: LaunchOptions = {},
): Promise<ElectronTestInstance> {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const launchEnvironment: Record<string, string> = {
    ...inheritedEnvironment,
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
  const consoleMessages: string[] = [];
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

async function getState(page: Page): Promise<FunctionalState> {
  return page.evaluate(() => {
    const testApi: unknown = window.neoncodeTest;
    if (!testApi || typeof testApi !== 'object' || !('getState' in testApi)
        || typeof testApi.getState !== 'function') {
      throw new Error('window.neoncodeTest is unavailable');
    }
    return testApi.getState() as FunctionalState;
  });
}

function requirePane(state: FunctionalState, paneId: string): PublicPaneState {
  const pane = state.panes.find((candidate) => candidate.paneId === paneId);
  assert(pane, `missing terminal state for ${paneId}`);
  return pane;
}

async function sendText(page: Page, paneId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ targetPaneId, input }) => window.neoncodeTest.sendText(targetPaneId, input),
    { targetPaneId: paneId, input: text },
  );
}

async function pasteText(page: Page, paneId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ targetPaneId, input }) => window.neoncodeTest.pasteText(targetPaneId, input),
    { targetPaneId: paneId, input: text },
  );
}

async function disconnectPaneSocket(page: Page, paneId: string): Promise<void> {
  await page.evaluate((targetPaneId) => window.neoncodeTest.disconnectPaneSocket(targetPaneId), paneId);
}

async function pressTerminalKey(page: Page, paneId: string, key: string): Promise<void> {
  const textarea = page.getByTestId(`terminal-${paneId}`).locator('.xterm-helper-textarea');
  await textarea.focus();
  await page.keyboard.press(key);
}

async function waitForActivePane(page: Page, workspaceId: string, paneId: string): Promise<void> {
  await page.waitForFunction(
    ({ expectedWorkspaceId, expectedPaneId }) => {
      const state = window.neoncodeTest.getState();
      const activeSurface = document.activeElement?.closest('.terminal-pane') as HTMLElement | null;
      return state.workspace.activeWorkspaceId === expectedWorkspaceId
        && state.workspace.activePaneId === expectedPaneId
        && state.panes.length > 0
        && state.panes.every((pane) => pane.started)
        && activeSurface?.dataset.paneId === expectedPaneId;
    },
    { expectedWorkspaceId: workspaceId, expectedPaneId: paneId },
    { timeout },
  );
  const surface = page.getByTestId(`terminal-pane-${paneId}`);
  assert(await surface.getAttribute('data-active') === 'true', `${paneId} did not expose active pane data`);
  assert(await surface.getAttribute('aria-current') === 'true', `${paneId} did not expose active pane ARIA state`);
}

async function verifyCockpitKeyboardNavigation(page: Page): Promise<void> {
  await waitForActivePane(page, 'default', 'shell');
  await page.keyboard.press('F6');
  await waitForActivePane(page, 'default', 'tasks');
  await page.keyboard.press('Shift+F6');
  await waitForActivePane(page, 'default', 'shell');

  await page.keyboard.press('Alt+Digit2');
  await waitForActivePane(page, 'review', 'review-shell');
  await page.keyboard.press('Alt+Digit1');
  await waitForActivePane(page, 'default', 'shell');
}

async function verifyCommandPalette(page: Page): Promise<void> {
  const commandsButton = page.getByTestId('commands-button');
  const overlay = page.getByTestId('command-palette-overlay');
  const input = page.getByTestId('command-palette-input');
  assert(await commandsButton.isVisible(), 'visible Commands button was not rendered');

  const dismissMetadata = await page.evaluate(() => (
    window.neoncodeTest.listCommands().find((command) => command.id === 'workspace.dismissAttention')
  ));
  assert(dismissMetadata?.title === 'Dismiss Workspace Attention', 'Dismiss command title was not catalog-backed');
  assert(dismissMetadata.category === 'Workspace', 'Dismiss command category was incorrect');
  assert(dismissMetadata.context === 'workspace', 'Dismiss command context was incorrect');
  assert(dismissMetadata.owningLayer === 'renderer', 'Dismiss command owning layer was incorrect');
  assert(dismissMetadata.externalInvocation === true, 'Dismiss command external eligibility was incorrect');
  assert(dismissMetadata.searchTerms.includes('notification'), 'Dismiss command search metadata was incomplete');

  await commandsButton.click();
  assert(await overlay.isVisible(), 'Commands button did not open the command palette');
  assert(await input.evaluate((element) => element === document.activeElement), 'palette search did not receive initial focus');
  await page.keyboard.press('Escape');
  assert(await overlay.isHidden(), 'Escape did not close the button-opened palette');

  await page.getByTestId('terminal-shell').locator('.xterm-helper-textarea').focus();
  await waitForActivePane(page, 'default', 'shell');
  await page.keyboard.press('Control+Shift+P');
  assert(await overlay.isVisible(), 'Ctrl+Shift+P did not open the command palette');
  assert(await input.evaluate((element) => element === document.activeElement), 'shortcut-opened palette did not focus search');
  await page.keyboard.type('Focus Pane');
  await page.keyboard.press('ArrowDown');
  const selectedTitle = await page.locator('.command-palette-option[aria-selected="true"] .command-palette-option-title').textContent();
  assert(selectedTitle === 'Focus Pane: Configured Tasks', `palette arrow selection chose ${selectedTitle}`);
  await page.keyboard.press('Enter');
  await waitForActivePane(page, 'default', 'tasks');
  assert(await overlay.isHidden(), 'executed palette command did not close the palette');

  await page.keyboard.press('Control+Shift+P');
  assert(await input.evaluate((element) => element === document.activeElement), 'reopened palette did not focus search');
  await page.keyboard.press('Escape');
  await waitForActivePane(page, 'default', 'tasks');
  assert(await overlay.isHidden(), 'Escape did not close the keyboard-opened palette');

  const beforeInputEvents = requirePane(await getState(page), 'tasks').inputEvents;
  await pressTerminalKey(page, 'tasks', 'Control+l');
  await page.waitForFunction(
    ({ paneId, previousInputEvents }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === paneId);
      return pane?.inputEvents === previousInputEvents + 1;
    },
    { paneId: 'tasks', previousInputEvents: beforeInputEvents },
    { timeout },
  );
}

async function verifySettingsUi(page: Page): Promise<void> {
  const overlay = page.getByTestId('settings-overlay');
  const settingsButton = page.getByTestId('settings-button');
  assert(await settingsButton.isVisible(), 'visible Settings button was not rendered');

  await settingsButton.click();
  assert(await overlay.isVisible(), 'Settings button did not open Settings');
  assert(
    await page.getByTestId('workspace-tab-settings').getAttribute('aria-selected') === 'true',
    'Settings did not render as the active workspace tab',
  );
  assert(await page.getByTestId('settings-general-tab').getAttribute('aria-selected') === 'true', 'General section was not selected');
  assert((await page.locator('.restart-badge').allTextContents()).every((text) => text === 'Restart required'), 'General restart labels were incomplete');
  await page.keyboard.press('Escape');
  assert(await overlay.isHidden(), 'Escape did not close button-opened Settings');
  assert(await page.getByTestId('workspace-tab-settings').count() === 0, 'Settings workspace tab did not close');
  await waitForActivePane(page, 'default', 'tasks');

  await page.keyboard.press('Control+Shift+P');
  const paletteInput = page.getByTestId('command-palette-input');
  await paletteInput.fill('Open Settings');
  await page.keyboard.press('Enter');
  assert(await overlay.isVisible(), 'Open Settings was not reachable through the command palette');

  const generalTab = page.getByTestId('settings-general-tab');
  assert(await generalTab.evaluate((element) => element === document.activeElement), 'Settings did not receive keyboard focus');
  assert(await page.getByTestId('settings-theme-preset').inputValue() === 'graphite', 'default theme preset was not selected');
  await page.getByTestId('settings-theme-preset').selectOption('tokyo-night');
  assert(await page.getByTestId('settings-terminal-background').inputValue() === '#09090d', 'theme preset did not populate color fields');
  await page.getByTestId('settings-accent').fill('#8b949e');
  await generalTab.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert(await page.getByTestId('settings-keyboard-tab').getAttribute('aria-selected') === 'true', 'Keyboard section was not keyboard selectable');

  const settingsRow = page.locator('.keybinding-row[data-command-id="settings.open"]');
  const settingsRecord = settingsRow.getByRole('button', { name: /Record shortcut/u });
  await settingsRecord.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('F6');
  assert((await page.getByTestId('settings-error').textContent())?.includes('conflicts'), 'shortcut conflict was not displayed inline');
  await page.keyboard.press('Escape');
  assert(await overlay.isVisible(), 'Escape while recording closed Settings instead of cancelling recording');

  await settingsRecord.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('F8');
  assert((await settingsRow.locator('.keybinding-current').textContent())?.includes('F8'), 'recorded shortcut was not shown');

  const paneNextRow = page.locator('.keybinding-row[data-command-id="pane.next"]');
  const paneNextUnbind = paneNextRow.getByRole('button', { name: /Unbind Focus Next Pane/u });
  await paneNextUnbind.focus();
  await page.keyboard.press('Enter');
  assert((await paneNextRow.locator('.keybinding-current').textContent())?.includes('Unbound'), 'Unbind did not update the draft');
  const paneNextReset = paneNextRow.getByRole('button', { name: /Reset Focus Next Pane/u });
  await paneNextReset.focus();
  await page.keyboard.press('Enter');
  assert((await paneNextRow.locator('.keybinding-current').textContent())?.includes('F6'), 'Reset did not restore the default');

  const save = page.getByTestId('settings-save');
  await save.focus();
  await page.keyboard.press('Enter');
  await overlay.waitFor({ state: 'hidden', timeout });
  assert(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nc-accent').trim()) === '#8b949e',
    'saved app theme accent was not applied immediately',
  );
  await waitForActivePane(page, 'default', 'tasks');

  await page.keyboard.press('F8');
  await overlay.waitFor({ state: 'visible', timeout });
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'hidden', timeout });
  await waitForActivePane(page, 'default', 'tasks');
}

async function verifyDynamicConfigReload(instance: ElectronTestInstance): Promise<void> {
  const { page, configDirectory } = instance;
  const before = await getState(page);
  const shellInstanceId = requirePane(before, 'shell').sessionInstanceId;
  const tasksInstanceId = requirePane(before, 'tasks').sessionInstanceId;
  const configPath = path.join(configDirectory, 'config.json');
  const config = parseJson<DesktopConfig>(fs.readFileSync(configPath, 'utf8'), 'dynamic reload config');
  const defaultWorkspace = config.workspaces.find((workspace) => workspace.id === 'default');
  assert(defaultWorkspace, 'dynamic reload config omitted default workspace');
  defaultWorkspace.name = 'Development Reloaded';
  config.appTheme.accent = '#44eeaa';
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  await page.waitForFunction(() => {
    const state = window.neoncodeTest.getState() as FunctionalState;
    return state.configuration.appTheme?.accent === '#44eeaa'
      && state.configuration.workspaces.some((workspace) => (
        workspace.id === 'default' && workspace.name === 'Development Reloaded'
      ));
  }, null, { timeout });

  assert(
    await page.getByTestId('workspace-default').locator('.workspace-name').textContent() === 'Development Reloaded',
    'external workspace rename was not rendered',
  );
  assert(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nc-accent').trim()) === '#44eeaa',
    'external theme change was not applied',
  );
  const after = await getState(page);
  assert(requirePane(after, 'shell').sessionInstanceId === shellInstanceId, 'theme/name reload restarted the shell pane');
  assert(requirePane(after, 'tasks').sessionInstanceId === tasksInstanceId, 'theme/name reload restarted the tasks pane');
}

async function verifyPersistedSettingsShortcut(page: Page): Promise<void> {
  const overlay = page.getByTestId('settings-overlay');
  await page.keyboard.press('F8');
  await overlay.waitFor({ state: 'visible', timeout });
  const settingsRow = page.locator('.keybinding-row[data-command-id="settings.open"]');
  assert((await settingsRow.locator('.keybinding-current').textContent())?.includes('F8'), 'saved shortcut did not survive relaunch');
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'hidden', timeout });
}

async function terminalPoint(
  page: Page,
  paneId: string,
  { xFraction = 0.5, yFraction = 0.5 }: TerminalPointOptions = {},
): Promise<{ x: number; y: number }> {
  const screen = page.getByTestId(`terminal-${paneId}`).locator('.xterm-screen');
  const box = await screen.boundingBox();
  assert(box, `xterm screen has no bounding box for ${paneId}`);
  return {
    x: box.x + box.width * xFraction,
    y: box.y + box.height * yFraction,
  };
}

async function terminalCellPoint(
  page: Page,
  paneId: string,
  row: number,
  column: number,
): Promise<{ x: number; y: number }> {
  const pane = (await getState(page)).panes.find((candidate) => candidate.paneId === paneId);
  assert(pane, `missing terminal state for ${paneId}`);
  assert(row >= 1 && row <= pane.rows, `terminal row ${row} is outside ${paneId}`);
  assert(column >= 1 && column <= pane.cols, `terminal column ${column} is outside ${paneId}`);
  return terminalPoint(page, paneId, {
    xFraction: (column - 0.5) / pane.cols,
    yFraction: (row - 0.5) / pane.rows,
  });
}

async function clickTerminal(
  page: Page,
  paneId: string,
  options?: TerminalPointOptions,
): Promise<{ x: number; y: number }> {
  const point = await terminalPoint(page, paneId, options);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function verifyMouseReporting(page: Page, paneId: string, token: string): Promise<void> {
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
  const output = requirePane(state, paneId).recentOutput;
  const hex = [...output.matchAll(/mouse-bytes-([0-9a-f]+)/g)].at(-1)?.[1];
  assert(hex, 'mouse report bytes were not captured');
  const report = Buffer.from(hex, 'hex').toString('binary');
  assert(
    /^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/.test(report),
    `unexpected SGR mouse report: ${JSON.stringify(report)}`,
  );
}

async function verifyTmuxMouseBehavior(page: Page, paneId: string, token: string): Promise<void> {
  const leftClickExpected = `tmux-click-0-${token}`;
  const resultPath = `/tmp/neoncode-tmux-wheel-${token}`;
  const historyExpected = `tmux-history-${token}`;
  await clickTerminal(page, paneId, { xFraction: 0.25, yFraction: 0.35 });
  // Keep pane-selection verification, history generation, and the copy-mode
  // watcher in one shell command. A marker from one command can precede the
  // prompt redraw, so sending setup as a second command was inherently racy.
  const setupCommand = `v=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_index}'); printf 'tmux-click-%s-%s\\n' "$v" '${token}'; rm -f '${resultPath}'; (j=0; while [ "$(tmux display-message -p -t "$TMUX_PANE" '#{pane_in_mode}')" != 1 ] && [ $j -lt 100 ]; do sleep 0.05; j=$((j+1)); done; [ "$(tmux display-message -p -t "$TMUX_PANE" '#{pane_in_mode}')" = 1 ] && printf 1 > '${resultPath}') & i=0; while [ $i -lt 120 ]; do printf 'tmux-line-%03d\\n' "$i"; i=$((i+1)); done; printf 'tmux-history-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(setupCommand, leftClickExpected);
  assertMarkerIsNotEchoed(setupCommand, historyExpected);
  await sendText(page, paneId, setupCommand);
  await waitForOutput(page, paneId, leftClickExpected);
  await waitForOutput(page, paneId, historyExpected);

  const leftPoint = await terminalPoint(page, paneId, { xFraction: 0.25, yFraction: 0.35 });
  await page.mouse.move(leftPoint.x, leftPoint.y);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
  }
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

async function verifyNeovimMouseBehavior(page: Page, paneId: string, token: string): Promise<void> {
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

  const output = requirePane(await getState(page), paneId).recentOutput;
  const result = [...output.matchAll(/nvim-mouse-result-(\d+)\r?\n(\d+)/g)].at(-1);
  assert(result?.[1] !== undefined && result[2] !== undefined, 'Neovim mouse result was not captured');
  const clickedLine = Number.parseInt(result[1], 10);
  const viewportTop = Number.parseInt(result[2], 10);
  assert(clickedLine === targetRow, `Neovim click selected line ${clickedLine}, expected ${targetRow}`);
  assert(viewportTop > 1, `Neovim wheel did not scroll the viewport: top line ${viewportTop}`);
}

async function waitForOutput(page: Page, paneId: string, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ targetPaneId, output }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === targetPaneId);
      return pane?.recentOutput.includes(output);
    },
    { targetPaneId: paneId, output: expected },
    { timeout },
  );
}

async function waitForEitherOutput(
  page: Page,
  paneId: string,
  expectedValues: string[],
): Promise<string> {
  await page.waitForFunction(
    ({ targetPaneId, outputs }) => {
      const pane = window.neoncodeTest.getState().panes.find((candidate) => candidate.paneId === targetPaneId);
      return outputs.some((output) => pane?.recentOutput.includes(output));
    },
    { targetPaneId: paneId, outputs: expectedValues },
    { timeout },
  );

  const pane = requirePane(await getState(page), paneId);
  const result = expectedValues.find((output) => pane.recentOutput.includes(output));
  assert(result, `none of the expected output values appeared in ${paneId}`);
  return result;
}

function assertMarkerIsNotEchoed(command: string, expected: string): void {
  assert(!command.includes(expected), `test command contains expected output marker: ${expected}`);
}

async function verifyKeyboardPaste(
  instance: ElectronTestInstance,
  paneId: string,
  shortcut: string,
  label: string,
  token: string,
): Promise<void> {
  const expected = `${label}-${token}`;
  const command = `printf '${label}-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(command, expected);
  const previousClipboard = await instance.electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const before = await getState(instance.page);
  const beforeInputs = requirePane(before, paneId).inputEvents;
  try {
    await instance.electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), command);
    await instance.page.evaluate(
      ({ targetPaneId, text }) => window.neoncodeTest.simulatePasteShortcutRace(targetPaneId, text),
      { targetPaneId: paneId, text: command },
    );
    await waitForOutput(instance.page, paneId, expected);
    const after = await getState(instance.page);
    const afterInputs = requirePane(after, paneId).inputEvents;
    assert(afterInputs === beforeInputs + 1, `${shortcut} pasted ${afterInputs - beforeInputs} times in ${paneId}`);
  } finally {
    await instance.electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
  }
}

async function verifyExecutedCommand(
  page: Page,
  paneId: string,
  label: string,
  token: string,
): Promise<void> {
  const expected = `${label}-${token}`;
  const command = `printf '${label}-%s\\n' '${token}'\n`;
  assertMarkerIsNotEchoed(command, expected);

  const before = await getState(page);
  const beforeInputEvents = requirePane(before, paneId).inputEvents;
  await sendText(page, paneId, command);
  await waitForOutput(page, paneId, expected);

  const after = await getState(page);
  const afterInputEvents = requirePane(after, paneId).inputEvents;
  assert(afterInputEvents === beforeInputEvents + 1, `${paneId} input event was not recorded exactly once`);
}

async function assertPaneLifecycles(
  instance: ElectronTestInstance,
  expectedLifecycle: SessionLifecycle,
): Promise<void> {
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

async function assertWorkspaceStatus(
  page: Page,
  workspaceId: string,
  expectedState: string,
  expectedText: string,
): Promise<void> {
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

async function switchWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(
    (targetWorkspaceId) => window.neoncodeTest.executeCommand('workspace.open', { workspaceId: targetWorkspaceId }),
    workspaceId,
  );
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

async function killAllPanes(instance: ElectronTestInstance): Promise<void> {
  const targets = (await getState(instance.page)).panes.map((pane) => pane.paneId);
  await instance.page.evaluate(async (paneIds) => {
    await Promise.all(paneIds.map((paneId) => window.neoncodeTest.killPane(paneId)));
  }, targets);
  try {
    await instance.page.waitForFunction((paneIds) => {
      const panes = window.neoncodeTest.getState().panes;
      return paneIds.every((paneId) => panes.find((pane) => pane.paneId === paneId)?.lifecycle === 'killed');
    }, targets, { timeout: 10_000 });
  } catch {
    const state = await getState(instance.page);
    throw new Error(`test sessions were not killed: ${JSON.stringify(state.panes.map((pane) => ({
      paneId: pane.paneId,
      lifecycle: pane.lifecycle,
      error: pane.error,
    })))}`);
  }
}

async function killAllWorkspaces(instance: ElectronTestInstance): Promise<void> {
  const workspaceIds = (await getState(instance.page)).configuration.workspaces.map((workspace) => workspace.id);
  for (const workspaceId of workspaceIds) {
    const state = await getState(instance.page);
    if (state.workspace.activeWorkspaceId !== workspaceId) {
      await switchWorkspace(instance.page, workspaceId);
    }
    await killAllPanes(instance);
  }
}

async function closeInstance(instance: ElectronTestInstance | undefined): Promise<void> {
  if (!instance) {
    return;
  }
  await instance.electronApp.close();
}

async function assertSecondInstanceDoesNotTouchConfig(instance: ElectronTestInstance): Promise<void> {
  const backupPath = path.join(instance.configDirectory, 'config.json.bak');
  const before = fs.statSync(backupPath);
  const secondInstanceEnvironment = { ...instance.launchEnvironment };
  delete secondInstanceEnvironment.NODE_OPTIONS;
  const child = spawn(requireElectronExecutable(electronExecutable), [appRoot], {
    cwd: appRoot,
    env: secondInstanceEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
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

async function cleanupSessions(sessionPrefix: string, configDirectory: string): Promise<void> {
  let cleanupInstance: ElectronTestInstance | undefined;
  try {
    cleanupInstance = await launchApp(sessionPrefix, configDirectory);
    await killAllWorkspaces(cleanupInstance);
  } catch (error) {
    log('cleanup.failed', { message: errorMessage(error) });
  } finally {
    await closeInstance(cleanupInstance).catch(() => {});
  }
}

async function runFirstLaunchChecks(
  instance: ElectronTestInstance,
  sessionPrefix: string,
  runToken: string,
): Promise<void> {
  const { electronApp, page, configDirectory } = instance;
  const windowState = await electronApp.evaluate(({ app, BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Electron main window is unavailable');
    const webContents = mainWindow.webContents as unknown as {
      getLastWebPreferences(): {
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        sandbox?: boolean;
      };
    };
    return {
      visible: mainWindow.isVisible(),
      contentSize: mainWindow.getContentSize(),
      webPreferences: webContents.getLastWebPreferences(),
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
        && Object.isFrozen(window.neoncodeDesktop.config.workspaces[0]?.sessions[0]?.launchProfile),
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
    JSON.stringify(rendererSecurity.desktopKeys) === JSON.stringify(['config', 'getSettings', 'getWorkspaceCatalog', 'onConfigChanged', 'onPrepareClose', 'readClipboardText', 'saveSettings', 'saveWorkspaceCatalog', 'saveWorkspaceLayout', 'setActiveWorkspace', 'writeClipboardText']),
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
  assert(initialState.configuration.confirmBeforeClosingTab === false, 'tab close confirmation should default off');
  assert(initialState.configuration.confirmBeforeClosingTerminal === false, 'terminal close confirmation should default off');
  assert(initialState.workspace.activeWorkspaceId === 'default', 'default workspace was not activated');
  assert(initialState.configuration.workspaces.length === 2, 'configured workspaces were not exposed');
  assert(await page.getByTestId('workspace-list').locator('.workspace-button').count() === 2, 'workspace selector was not rendered');
  assert(
    await page.getByTestId('workspace-default').getAttribute('aria-current') === 'true',
    'default workspace was not visibly selected',
  );
  await assertWorkspaceStatus(page, 'default', 'running', '2 running');
  await assertWorkspaceStatus(page, 'review', 'idle', 'Not started');
  const initialLocation = page.getByTestId('workspace-default').locator('.workspace-location');
  assert(await initialLocation.textContent() === 'WSL · 2 paths', 'workspace location summary was not rendered');
  assert(
    ['hub', 'runtime'].includes(await initialLocation.getAttribute('data-source') ?? ''),
    'started workspace location was not hub-authoritative',
  );
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
    const actual = requirePane(initialState, expected.paneId);
    for (const key of ['paneId', 'sessionKey', 'sessionId'] as const) {
      assert(actual[key] === expected[key], `${expected.paneId} expected ${key}=${expected[key]}, got ${actual[key]}`);
    }
  }
  await assertPaneLifecycles(instance, 'started');
  const commandIds = await page.evaluate(() => window.neoncodeTest.listCommands().map((command) => command.id));
  assert(
    JSON.stringify(commandIds) === JSON.stringify([
      'palette.open',
      'palette.close',
      'settings.open',
      'settings.close',
      'workspace.create',
      'workspace.rename',
      'workspace.delete',
      'workspace.createDialog',
      'workspace.renameDialog',
      'workspace.deleteDialog',
      'workspace.open',
      'workspace.openIndex',
      'workspace.next',
      'workspace.previous',
      'workspace.dismissAttention',
      'tab.create',
      'tab.open',
      'tab.rename',
      'tab.move',
      'tab.close',
      'tab.createDefault',
      'tab.next',
      'tab.previous',
      'tab.renameDialog',
      'tab.closeDialog',
      'pane.focus',
      'pane.focusIndex',
      'pane.split',
      'split.resize',
      'pane.close',
      'pane.kill',
      'pane.restart',
      'pane.splitHorizontal',
      'pane.splitVertical',
      'pane.resizeLeft',
      'pane.resizeRight',
      'pane.resizeUp',
      'pane.resizeDown',
      'pane.closeDialog',
      'pane.next',
      'pane.previous',
    ]),
    `unexpected command registry metadata: ${commandIds.join(',')}`,
  );
  const workspaceTabs = page.getByTestId('workspace-tabs');
  assert(await workspaceTabs.getAttribute('role') === 'tablist', 'workspace tablist role was not rendered');
  assert(await workspaceTabs.getByRole('tab').count() === 1, 'seeded workspace did not render one tab');
  assert(
    await workspaceTabs.getByRole('tab').getAttribute('aria-selected') === 'true',
    'seeded workspace tab was not selected',
  );
  assert(
    await page.getByTestId('pane-title-shell').textContent() === 'Configured Shell',
    'configured shell title was not rendered',
  );
  assert(
    await page.getByTestId('pane-title-tasks').textContent() === 'Configured Tasks',
    'configured tasks title was not rendered',
  );
  await verifyCockpitKeyboardNavigation(page);
  await verifyCommandPalette(page);
  await verifySettingsUi(page);
  await verifyDynamicConfigReload(instance);

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

  const ctrlDReady = `ctrl-d-ready-${runToken}`;
  const ctrlDExpected = `ctrl-d-${runToken}`;
  const ctrlDCommand = `printf 'ctrl-d-ready-%s\\n' '${runToken}'; cat >/dev/null; printf 'ctrl-d-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(ctrlDCommand, ctrlDReady);
  assertMarkerIsNotEchoed(ctrlDCommand, ctrlDExpected);
  await sendText(page, 'shell', ctrlDCommand);
  await waitForOutput(page, 'shell', ctrlDReady);
  await pressTerminalKey(page, 'shell', 'Control+d');
  await waitForOutput(page, 'shell', ctrlDExpected);

  const ctrlZReady = `ctrl-z-ready-${runToken}`;
  const ctrlZExpected = `ctrl-z-${runToken}`;
  const ctrlZCommand = `printf 'ctrl-z-ready-%s\\n' '${runToken}'; sleep 30; printf 'ctrl-z-%s\\n' '${runToken}'\n`;
  assertMarkerIsNotEchoed(ctrlZCommand, ctrlZReady);
  assertMarkerIsNotEchoed(ctrlZCommand, ctrlZExpected);
  await sendText(page, 'shell', ctrlZCommand);
  await waitForOutput(page, 'shell', ctrlZReady);
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
  const keyOutput = requirePane(keyState, 'shell').recentOutput;
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
  const heavyPane = requirePane(heavyState, 'tasks');
  assert(
    heavyPane.outputGap === '',
    `20,000-line output soak produced a sequence gap: ${heavyPane.outputGap}`,
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

  if (tmuxResult.includes('present') && runGuiOnlyChecks) {
    const tmuxSession = `neoncode-${runToken}`;
    const tmuxSocket = `neoncode-${runToken}`;
    await sendText(page, 'tasks', `tmux -f /dev/null -L '${tmuxSocket}' new-session -d -s '${tmuxSession}' \\; set-option -g mouse on \\; split-window -h \\; select-pane -t ':0.1' \\; attach-session -t '${tmuxSession}'\n`);
    await page.waitForTimeout(1500);
    const tmuxReadyExpected = `tmux-ready-${runToken}`;
    const tmuxReadyCommand = `printf 'tmux-ready-%s\n' '${runToken}'\n`;
    assertMarkerIsNotEchoed(tmuxReadyCommand, tmuxReadyExpected);
    await sendText(page, 'tasks', tmuxReadyCommand);
    await waitForOutput(page, 'tasks', tmuxReadyExpected);
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

  if (nvimResult.includes('present') && runGuiOnlyChecks) {
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
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Electron main window is unavailable during resize');
    mainWindow.setContentSize(1400, 900);
  });
  await page.waitForFunction(
    (before) => {
      const state = window.neoncodeTest.getState();
      return state.panes.every((pane, index) => {
        const previous = before[index];
        return previous !== undefined && pane.resizeEvents > previous.resizeEvents;
      }) && state.panes.some((pane, index) => {
        const previous = before[index];
        return previous !== undefined && (pane.rows !== previous.rows || pane.cols !== previous.cols);
      });
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
  const beforeReconnectPane = requirePane(beforeReconnect, 'shell');
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
  const afterReconnectPane = requirePane(await getState(page), 'shell');
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

async function runSecondLaunchChecks(
  instance: ElectronTestInstance,
  sessionPrefix: string,
  runToken: string,
): Promise<void> {
  const restoredWindowSize = await instance.electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Electron main window is unavailable after relaunch');
    return mainWindow.getContentSize();
  });
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
    assert(
      typeof summary.instanceId === 'string' && /^[0-9a-f]{32}$/.test(summary.instanceId),
      `${summary.sessionId} instance id was invalid`,
    );
    assert(summary.command === 'bash', `${summary.sessionId} command metadata was not bash`);
    assert(summary.persistent === true, `${summary.sessionId} was not reported persistent`);
    assert(summary.attachmentCount === 0, `${summary.sessionId} was unexpectedly attached during discovery`);
  }
  const agentSummary = summaries.find((summary) => summary.sessionId === `${sessionPrefix}-review-agent`);
  assert(agentSummary, 'review agent summary was not retained by the hub');
  assert(
    agentSummary.state === 'exited' || agentSummary.state === 'running',
    `review agent had unexpected retained state ${agentSummary.state}`,
  );
  assert(agentSummary.latestExit?.status === 7, 'retained review agent exit status was not 7');
  assert(agentSummary.latestExit?.reason === 'process_exit', 'retained review agent exit reason was incorrect');
  const shellSummary = summaries.find((summary) => summary.sessionId === `${sessionPrefix}-shell`);
  assert(shellSummary, 'default shell summary was not retained by the hub');
  assert(shellSummary.cwd === null, 'hub did not preserve the original default cwd metadata');
  const firstWorkspace = state.configuration.workspaces[0];
  const firstSession = firstWorkspace?.sessions[0];
  assert(firstSession, 'recovered frontend configuration omitted the default session');
  assert(
    firstSession.launchProfile.cwd === '/changed-after-start',
    'recovered frontend configuration did not contain the changed cwd',
  );
  const restoredLocation = instance.page.getByTestId('workspace-default').locator('.workspace-location');
  assert(
    ['hub', 'runtime'].includes(await restoredLocation.getAttribute('data-source') ?? ''),
    'restored workspace location was not hub-authoritative',
  );
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
    const validLifecycles = pane.paneId === 'review-agent' ? ['started', 'attached'] : ['attached'];
    assert(
      validLifecycles.includes(pane.lifecycle),
      `${pane.paneId} expected ${validLifecycles.join(' or ')}, got ${pane.lifecycle}`,
    );
  }
  await instance.page.getByTestId('workspace-acknowledge-review').click();
  await instance.page.waitForFunction(() => (
    (document.querySelector('[data-testid="workspace-status-review"]') as HTMLElement | null)
      ?.dataset.state === 'running'
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
    requirePane(state, 'review-shell').recentOutput.includes(reviewSeedExpected),
    'active review workspace output was not replayed after relaunch',
  );

  await switchWorkspace(instance.page, 'default');
  state = await getState(instance.page);
  await assertWorkspaceStatus(instance.page, 'default', 'running', '2 running');
  await assertWorkspaceStatus(instance.page, 'review', 'detached', '3 detached');
  await assertPaneLifecycles(instance, 'attached');
  const seedExpected = `seed-${runToken}`;
  assert(
    requirePane(state, 'shell').recentOutput.includes(seedExpected),
    'inactive default workspace output was not replayed after switching back',
  );

  const restoredExpected = `restored-${runToken}`;
  const restoredCommand = `printf 'restored-%s\\n' "$NEONCODE_TEST_PERSIST"\n`;
  assertMarkerIsNotEchoed(restoredCommand, restoredExpected);
  await sendText(instance.page, 'shell', restoredCommand);
  await waitForOutput(instance.page, 'shell', restoredExpected);
}

async function runWorkspaceCatalogCheck(runToken: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-workspace-catalog-'));
  const sessionPrefix = `workspace-catalog-${runToken}`;
  let instance: ElectronTestInstance | undefined;
  let createdWorkspaceId = '';
  let createdSessionId = '';
  try {
    writeTestConfig(directory);
    instance = await launchApp(sessionPrefix, directory);
    const staleRejected = await instance.page.evaluate(async () => {
      const first = await window.neoncodeDesktop.getWorkspaceCatalog();
      const second = await window.neoncodeDesktop.getWorkspaceCatalog();
      await window.neoncodeDesktop.saveWorkspaceCatalog(first);
      try {
        await window.neoncodeDesktop.saveWorkspaceCatalog(second);
        return false;
      } catch {
        return true;
      }
    });
    assert(staleRejected, 'stale workspace catalog revision was accepted');

    const createButton = instance.page.getByTestId('workspace-create-button');
    assert(await createButton.isVisible(), 'visible + Workspace button was not rendered');
    await createButton.click();
    const dialog = instance.page.getByTestId('workspace-dialog-overlay');
    await dialog.waitFor({ state: 'visible', timeout });
    const nameInput = instance.page.getByTestId('workspace-name');
    assert(await nameInput.evaluate((element) => element === document.activeElement), 'create dialog did not focus Name');
    await instance.page.keyboard.type('Created Workspace');
    await instance.page.keyboard.press('Tab');
    await instance.page.keyboard.type('/tmp');
    await instance.page.keyboard.press('Tab');
    await instance.page.keyboard.press('Tab');
    await instance.page.keyboard.press('Tab');
    await instance.page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden', timeout });
    await instance.page.waitForFunction(() => {
      const workspaces: unknown = window.neoncodeTest.getState().configuration.workspaces;
      return Array.isArray(workspaces)
        && workspaces.some((workspace: unknown) => (
          typeof workspace === 'object' && workspace !== null
            && (workspace as { name?: unknown }).name === 'Created Workspace'
        ));
    }, null, { timeout });

    let persisted = parseJson<DesktopConfig>(
      fs.readFileSync(path.join(directory, 'config.json'), 'utf8'),
      'created workspace configuration',
    );
    const created = persisted.workspaces.find((workspace) => workspace.name === 'Created Workspace');
    assert(created, 'created workspace was not persisted');
    createdWorkspaceId = created.id;
    createdSessionId = created.sessions[0]!.id;
    assert(created.path === '/tmp', 'created workspace path was not persisted');
    assert(created.defaultLaunchProfile === 'default-shell', 'created default profile was not persisted');
    await instance.page.waitForFunction((workspaceId) => (
      window.neoncodeTest.getState().workspace.activeWorkspaceId === workspaceId
        && window.neoncodeTest.getState().panes.length === 1
        && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), createdWorkspaceId, { timeout });
    const createdPane = (await getState(instance.page)).panes[0];
    assert(createdPane, 'created workspace did not start a terminal');
    const cwdMarker = `created-cwd-${runToken}`;
    await sendText(instance.page, createdPane.paneId, `printf 'created-cwd-%s-${runToken}\\n' "$PWD"\n`);
    await waitForOutput(instance.page, createdPane.paneId, `${cwdMarker.replace(`-${runToken}`, '')}-/tmp-${runToken}`);

    await instance.page.keyboard.press('Control+Shift+P');
    await instance.page.getByTestId('command-palette-input').fill('Rename Current Workspace');
    await instance.page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible', timeout });
    const renameName = instance.page.getByTestId('workspace-name');
    await renameName.focus();
    await instance.page.keyboard.press('Control+a');
    await instance.page.keyboard.type('Renamed Workspace');
    await instance.page.getByTestId('workspace-dialog-submit').focus();
    await instance.page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden', timeout });
    assert(
      await instance.page.getByTestId(`workspace-${createdWorkspaceId}`).locator('.workspace-name').textContent()
        === 'Renamed Workspace',
      'renamed workspace was not updated in the sidebar',
    );
    persisted = parseJson<DesktopConfig>(
      fs.readFileSync(path.join(directory, 'config.json'), 'utf8'),
      'renamed workspace configuration',
    );
    assert(
      persisted.workspaces.find((workspace) => workspace.id === createdWorkspaceId)?.name === 'Renamed Workspace',
      'renamed workspace was not persisted',
    );

    await closeInstance(instance);
    instance = await launchApp(sessionPrefix, directory);
    assert(
      (await getState(instance.page)).workspace.activeWorkspaceId === createdWorkspaceId,
      'created workspace was not restored active after relaunch',
    );
    assert(
      await instance.page.getByTestId(`workspace-${createdWorkspaceId}`).locator('.workspace-name').textContent()
        === 'Renamed Workspace',
      'renamed workspace did not survive relaunch',
    );

    await instance.page.keyboard.press('Control+Shift+P');
    await instance.page.getByTestId('command-palette-input').fill('Delete Current Workspace');
    await instance.page.keyboard.press('Enter');
    const relaunchedDialog = instance.page.getByTestId('workspace-dialog-overlay');
    await relaunchedDialog.waitFor({ state: 'visible', timeout });
    await instance.page.getByTestId('workspace-dialog-submit').focus();
    await instance.page.keyboard.press('Enter');
    await relaunchedDialog.waitFor({ state: 'hidden', timeout });
    await instance.page.waitForFunction((workspaceId) => {
      const workspaces: unknown = window.neoncodeTest.getState().configuration.workspaces;
      return Array.isArray(workspaces)
        && !workspaces.some((workspace: unknown) => (
          typeof workspace === 'object' && workspace !== null
            && (workspace as { id?: unknown }).id === workspaceId
        ));
    }, createdWorkspaceId, { timeout });
    assert(
      (await getState(instance.page)).sessionDiscovery.sessions.includes(`${sessionPrefix}-${createdSessionId}`),
      'detach deletion silently removed the durable hub session',
    );

    const recreate = await instance.page.evaluate(async ({ workspaceId, sessionId }) => (
      window.neoncodeTest.executeCommand('workspace.create', {
        workspaceId: `${workspaceId}-cleanup`,
        name: 'Cleanup Workspace',
        path: '/tmp',
        defaultLaunchProfile: 'default-shell',
        sessionId,
        title: 'Shell',
      })
    ), { workspaceId: createdWorkspaceId, sessionId: createdSessionId });
    assert(recreate.status === 'completed', 'detached session could not be reattached for cleanup');
    await instance.page.waitForFunction((sessionId) => (
      window.neoncodeTest.getState().panes.some((pane) => pane.sessionKey === sessionId && pane.started)
    ), createdSessionId, { timeout });
    const cleanupWorkspaceId = `${createdWorkspaceId}-cleanup`;
    const cleanupDelete = await instance.page.evaluate((workspaceId) => (
      window.neoncodeTest.executeCommand('workspace.delete', { workspaceId, disposition: 'kill' })
    ), cleanupWorkspaceId);
    assert(cleanupDelete.status === 'completed', 'cleanup workspace was not killed');

    const deleteReview = await instance.page.evaluate(() => (
      window.neoncodeTest.executeCommand('workspace.delete', {
        workspaceId: 'review', disposition: 'kill',
      })
    ));
    assert(deleteReview.status === 'completed', 'review workspace delete failed');
    const lastGuard = await instance.page.evaluate(() => (
      window.neoncodeTest.executeCommand('workspace.delete', {
        workspaceId: 'default', disposition: 'detach',
      })
    ));
    assert(
      lastGuard.status === 'disabled' && lastGuard.reason === 'Cannot delete the last workspace',
      'last-workspace delete guard was not enforced',
    );
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runPersistentTabCheck(runToken: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-tabs-'));
  const sessionPrefix = `tabs-${runToken}`;
  let instance: ElectronTestInstance | undefined;
  try {
    writeTestConfig(directory);
    instance = await launchApp(sessionPrefix, directory);
    const { page } = instance;
    const tabs = page.getByTestId('workspace-tabs').getByRole('tab');
    assert(await tabs.count() === 1, 'configured grid did not seed one visible tab');
    const seededTabId = await tabs.first().getAttribute('data-tab-id');
    assert(seededTabId, 'seeded tab omitted its stable ID');

    await page.keyboard.press('Control+Shift+T');
    await page.waitForFunction(() => (
      document.querySelectorAll('#workspace-tabs [role="tab"]').length === 2
      && window.neoncodeTest.getState().panes.length === 3
    ));
    const selected = page.locator('#workspace-tabs [role="tab"][aria-selected="true"]');
    const createdTabId = await selected.getAttribute('data-tab-id');
    assert(createdTabId && createdTabId !== seededTabId, 'create shortcut did not activate a new stable tab');
    assert(await page.locator('.terminal-pane').count() === 3, 'workspace tabs did not keep mounted terminal surfaces');
    const createdPaneId = (await getState(page)).workspace.activePaneId;
    assert(createdPaneId, 'created tab did not attach its terminal pane');
    const createdBox = await page.getByTestId(`terminal-pane-${createdPaneId}`).boundingBox();
    assert(
      createdBox !== null && createdBox.width > 0 && createdBox.height > 0,
      'created tab terminal did not receive positive dimensions',
    );

    const renameOpen = await page.evaluate(() => window.neoncodeTest.executeCommand('tab.renameDialog'));
    assert(renameOpen.status === 'completed', 'rename tab dialog command failed');
    await page.getByTestId('tab-title').fill('Persistent tab');
    await page.getByTestId('tab-title').press('Enter');
    await page.waitForFunction(() => (
      document.querySelector('#workspace-tabs [role="tab"][aria-selected="true"]')?.textContent
        === 'Persistent tab'
    ));

    const continuityMarker = `tab-continuity-${runToken}`;
    await sendText(page, createdPaneId, `printf '${continuityMarker}\\n'\n`);
    await waitForOutput(page, createdPaneId, continuityMarker);
    await page.keyboard.press('Control+PageUp');
    await page.waitForFunction((expectedTabId) => (
      document.querySelector('#workspace-tabs [role="tab"][aria-selected="true"]')
        ?.getAttribute('data-tab-id') === expectedTabId
      && window.neoncodeTest.getState().panes.length === 3
    ), seededTabId);
    const seededPaneIds = ['shell', 'tasks'];
    await page.keyboard.press('F6');
    assert(
      seededPaneIds.includes((await getState(page)).workspace.activePaneId ?? ''),
      'F6 escaped the active tab pane order',
    );
    await page.keyboard.press('Control+PageDown');
    await page.waitForFunction((expectedTabId) => (
      document.querySelector('#workspace-tabs [role="tab"][aria-selected="true"]')
        ?.getAttribute('data-tab-id') === expectedTabId
      && window.neoncodeTest.getState().panes.length === 3
    ), createdTabId);
    await waitForOutput(page, createdPaneId, continuityMarker);

    await closeInstance(instance);
    instance = undefined;
    instance = await launchApp(sessionPrefix, directory);
    const restored = instance.page.locator('#workspace-tabs [role="tab"][aria-selected="true"]');
    assert(await restored.textContent() === 'Persistent tab', 'renamed active tab was not restored');
    assert(await restored.getAttribute('data-tab-id') === createdTabId, 'restored tab identity changed');
    assert((await getState(instance.page)).panes.length === 3, 'restored workspace did not keep tab terminals mounted');

    const closeResult = await instance.page.evaluate(({ tabId }) => (
      window.neoncodeTest.executeCommand('tab.close', {
        workspaceId: 'default', tabId,
      })
    ), { tabId: createdTabId });
    assert(closeResult.status === 'completed', 'kill-close tab transaction failed');
    await instance.page.waitForFunction(() => {
      const panes = window.neoncodeTest.getState().panes;
      return document.querySelectorAll('#workspace-tabs [role="tab"]').length === 1
        && panes.length === 2
        && panes.every((pane) => pane.started);
    });
    const lastGuard = await instance.page.evaluate(({ tabId }) => (
      window.neoncodeTest.executeCommand('tab.close', {
        workspaceId: 'default', tabId,
      })
    ), { tabId: seededTabId });
    assert(
      lastGuard.status === 'disabled' && lastGuard.reason === 'Cannot close the last tab',
      'last-tab close guard was not enforced',
    );
    const persistedConfig = parseJson<DesktopConfig>(
      fs.readFileSync(path.join(directory, 'config.json'), 'utf8'),
      'tab test config',
    );
    assert(
      persistedConfig.workspaces.find((workspace) => workspace.id === 'default')?.sessions.length === 2,
      'closed tab session remained in the durable catalog',
    );
    await killAllPanes(instance);
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runPaneLayoutCheck(runToken: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-pane-layout-'));
  const sessionPrefix = `pane-layout-${runToken}`;
  let instance: ElectronTestInstance | undefined;
  try {
    writeTestConfig(directory);
    const configPath = path.join(directory, 'config.json');
    const config = parseJson<DesktopConfig>(fs.readFileSync(configPath, 'utf8'), 'pane layout config');
    const workspace = config.workspaces.find((candidate) => candidate.id === 'default');
    assert(workspace, 'pane layout config omitted default workspace');
    config.persistence.confirmBeforeClosingTerminal = true;
    workspace.path = '/tmp';
    workspace.layout.columns = 1;
    workspace.sessions = [workspace.sessions[0]!];
    config.workspaces = [workspace];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    instance = await launchApp(sessionPrefix, directory);
    let { page } = instance;
    await waitForActivePane(page, 'default', 'shell');

    await page.keyboard.press('Alt+Shift+=');
    await page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.length === 2
      && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    let state = await getState(page);
    const firstSplitPaneId = state.workspace.activePaneId;
    assert(firstSplitPaneId && firstSplitPaneId !== 'shell', 'side-by-side split did not focus a new pane');
    assert(await page.locator('.layout-separator[aria-orientation="vertical"]').count() === 1,
      'side-by-side split omitted its accessible vertical separator');

    await page.keyboard.press('Alt+Shift+-');
    await page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.length === 3
      && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    state = await getState(page);
    const secondSplitPaneId = state.workspace.activePaneId;
    assert(secondSplitPaneId && secondSplitPaneId !== firstSplitPaneId && secondSplitPaneId !== 'shell',
      'stacked split did not focus a second new pane');
    assert(await page.locator('.layout-separator[aria-orientation="horizontal"]').count() === 1,
      'stacked split omitted its accessible horizontal separator');
    for (const pane of state.panes) {
      const box = await page.getByTestId(`terminal-pane-${pane.paneId}`).boundingBox();
      assert(box && box.width > 0 && box.height > 0, `${pane.paneId} did not have positive split dimensions`);
    }

    const cwdMarker = `pane-cwd-/tmp-${runToken}`;
    const cwdCommand = `printf 'pane-cwd-%s-${runToken}\\n' "$PWD"\n`;
    assertMarkerIsNotEchoed(cwdCommand, cwdMarker);
    await sendText(page, secondSplitPaneId, cwdCommand);
    await waitForOutput(page, secondSplitPaneId, cwdMarker);

    await page.keyboard.press('F6');
    await waitForActivePane(page, 'default', 'shell');
    await page.keyboard.press('F6');
    await waitForActivePane(page, 'default', firstSplitPaneId);
    await page.keyboard.press('F6');
    await waitForActivePane(page, 'default', secondSplitPaneId);

    const shellBefore = await page.getByTestId('terminal-pane-shell').boundingBox();
    assert(shellBefore, 'shell pane omitted a pre-resize bounding box');
    const verticalSeparator = page.locator('.layout-separator[aria-orientation="vertical"]').first();
    const ratioBefore = Number.parseInt(await verticalSeparator.getAttribute('aria-valuenow') ?? '', 10);
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await page.waitForFunction((previousWidth) => {
      const shell = document.querySelector<HTMLElement>('[data-testid="terminal-pane-shell"]');
      return shell !== null && shell.getBoundingClientRect().width < previousWidth - 2;
    }, shellBefore.width, { timeout });
    const shellAfter = await page.getByTestId('terminal-pane-shell').boundingBox();
    assert(shellAfter && shellAfter.width < shellBefore.width, 'directional resize did not change bounding ratio');
    const ratioAfter = Number.parseInt(await verticalSeparator.getAttribute('aria-valuenow') ?? '', 10);
    assert(ratioAfter === ratioBefore - 5, `resize ratio changed ${ratioBefore} -> ${ratioAfter}, expected one step`);

    await closeInstance(instance);
    instance = await launchApp(sessionPrefix, directory);
    page = instance.page;
    await page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.length === 3
      && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    const restoredRatio = Number.parseInt(
      await page.locator('.layout-separator[aria-orientation="vertical"]').first()
        .getAttribute('aria-valuenow') ?? '',
      10,
    );
    assert(restoredRatio === ratioAfter, 'directional resize ratio did not persist across relaunch');
    await waitForActivePane(page, 'default', secondSplitPaneId);

    await sendText(page, secondSplitPaneId, `export NEONCODE_PANE_CONTINUITY='kept-${runToken}'\n`);
    const killResult = await page.evaluate((paneId) => window.neoncodeTest.executeCommand(
      'pane.kill', { workspaceId: 'default', paneId },
    ), secondSplitPaneId);
    assert(killResult.status === 'completed', 'pane lifecycle kill failed');
    const restartKilled = await page.evaluate((paneId) => window.neoncodeTest.executeCommand(
      'pane.restart', { workspaceId: 'default', paneId },
    ), secondSplitPaneId);
    assert(restartKilled.status === 'completed', 'killed pane restart failed');
    await page.waitForFunction((paneId) => (
      window.neoncodeTest.getState().panes.find((pane) => pane.paneId === paneId)?.started === true
    ), secondSplitPaneId, { timeout });
    const replacementMarker = `pane-replacement-fresh-${runToken}`;
    const replacementCommand = `printf 'pane-replacement-%s-${runToken}\\n' "${'${NEONCODE_PANE_CONTINUITY:-fresh}'}"\n`;
    assertMarkerIsNotEchoed(replacementCommand, replacementMarker);
    await sendText(page, secondSplitPaneId, replacementCommand);
    await waitForOutput(page, secondSplitPaneId, replacementMarker);

    state = await getState(page);
    const closedSecondHubSessionId = requirePane(state, secondSplitPaneId).sessionId;
    const closedFirstHubSessionId = requirePane(state, firstSplitPaneId).sessionId;
    const firstDialogOpen = await page.evaluate(() => window.neoncodeTest.executeCommand('pane.closeDialog'));
    assert(firstDialogOpen.status === 'completed', 'pane close dialog did not open');
    const paneDialog = page.getByTestId('pane-dialog-overlay');
    await paneDialog.waitFor({ state: 'visible', timeout });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await paneDialog.waitFor({ state: 'hidden', timeout });
    await waitForActivePane(page, 'default', secondSplitPaneId);
    const secondDialogOpen = await page.evaluate(() => window.neoncodeTest.executeCommand('pane.closeDialog'));
    assert(secondDialogOpen.status === 'completed', 'pane close dialog was not reusable');
    await paneDialog.waitFor({ state: 'visible', timeout });
    const paneDialogSubmit = page.getByTestId('pane-dialog-submit');
    assert(await paneDialogSubmit.isEnabled(), 'reused pane close dialog left its controls disabled');
    await paneDialogSubmit.focus();
    await page.keyboard.press('Enter');
    await paneDialog.waitFor({ state: 'hidden', timeout });
    await page.waitForFunction(() => window.neoncodeTest.getState().panes.length === 2, null, { timeout });
    const closeKill = await page.evaluate((paneId) => window.neoncodeTest.executeCommand(
      'pane.close', { workspaceId: 'default', paneId },
    ), firstSplitPaneId);
    assert(closeKill.status === 'completed', 'kill-close pane transaction failed');
    await page.waitForFunction(() => window.neoncodeTest.getState().panes.length === 1, null, { timeout });
    assert(await page.locator('.layout-separator').count() === 0, 'closing panes did not collapse split parents');
    const soleGuard = await page.evaluate(() => window.neoncodeTest.executeCommand(
      'pane.close', { workspaceId: 'default', paneId: 'shell' },
    ));
    assert(soleGuard.status === 'disabled' && soleGuard.reason === 'Cannot close the last pane in a tab',
      'sole-pane close guard was not enforced');

    await closeInstance(instance);
    instance = await launchApp(sessionPrefix, directory);
    state = await getState(instance.page);
    assert(!state.sessionDiscovery.sessions.includes(closedSecondHubSessionId),
      'closed pane left its hub session running');
    assert(!state.sessionDiscovery.sessions.includes(closedFirstHubSessionId),
      'kill-close pane left its hub session running');
    assert(state.panes.length === 1 && state.panes[0]?.paneId === 'shell',
      'collapsed one-pane layout did not persist across relaunch');
    await instance.page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    await killAllPanes(instance);
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runCloseConfirmationCheck(runToken: string): Promise<void> {
  const defaultDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-close-default-'));
  const confirmDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-close-confirm-'));
  let instance: ElectronTestInstance | undefined;
  try {
    writeTestConfig(defaultDirectory);
    instance = await launchApp(`close-default-${runToken}`, defaultDirectory);
    const createTab = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('tab.createDefault'));
    assert(createTab.status === 'completed', 'default close test could not create a second tab');
    await instance.page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role="tab"]').length === 2, null, { timeout });
    const tabClose = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('tab.closeDialog'));
    assert(tabClose.status === 'completed', 'default tab close command failed');
    await instance.page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role="tab"]').length === 1, null, { timeout });
    assert(await instance.page.getByTestId('tab-dialog-overlay').isHidden(), 'default tab close showed confirmation');
    const paneClose = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('pane.closeDialog'));
    assert(paneClose.status === 'completed', 'default pane close command failed');
    await instance.page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.length === 1
        && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    assert(await instance.page.getByTestId('pane-dialog-overlay').isHidden(), 'default pane close showed confirmation');
    await killAllPanes(instance);
    await closeInstance(instance);
    instance = undefined;

    writeTestConfig(confirmDirectory);
    const configPath = path.join(confirmDirectory, 'config.json');
    const config = parseJson<DesktopConfig>(fs.readFileSync(configPath, 'utf8'), 'confirm close config');
    config.persistence.confirmBeforeClosingTab = true;
    config.persistence.confirmBeforeClosingTerminal = true;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    instance = await launchApp(`close-confirm-${runToken}`, confirmDirectory);
    const confirmPaneClose = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('pane.closeDialog'));
    assert(confirmPaneClose.status === 'completed', 'confirm pane close command failed');
    const paneDialog = instance.page.getByTestId('pane-dialog-overlay');
    await paneDialog.waitFor({ state: 'visible', timeout });
    await instance.page.keyboard.press('Escape');
    await paneDialog.waitFor({ state: 'hidden', timeout });
    const createConfirmTab = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('tab.createDefault'));
    assert(createConfirmTab.status === 'completed', 'confirm close test could not create a second tab');
    await instance.page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role="tab"]').length === 2, null, { timeout });
    const confirmTabClose = await instance.page.evaluate(() => window.neoncodeTest.executeCommand('tab.closeDialog'));
    assert(confirmTabClose.status === 'completed', 'confirm tab close command failed');
    const tabDialog = instance.page.getByTestId('tab-dialog-overlay');
    await tabDialog.waitFor({ state: 'visible', timeout });
    await instance.page.keyboard.press('Escape');
    await tabDialog.waitFor({ state: 'hidden', timeout });
    await instance.page.waitForFunction(() => (
      window.neoncodeTest.getState().panes.length > 0
        && window.neoncodeTest.getState().panes.every((pane) => pane.started)
    ), null, { timeout });
    await killAllPanes(instance);
  } finally {
    await closeInstance(instance).catch(() => {});
    fs.rmSync(defaultDirectory, { recursive: true, force: true });
    fs.rmSync(confirmDirectory, { recursive: true, force: true });
  }
}

async function runKillPolicyCheck(runToken: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-kill-policy-'));
  const sessionPrefix = `kill-policy-${runToken}`;
  let instance: ElectronTestInstance | undefined;
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

async function runInvalidConfigurationCheck(runToken: string): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-invalid-config-'));
  let instance: ElectronTestInstance | undefined;
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

async function main(): Promise<void> {
  log('launch', { appRoot, endpoint, suite: electronTestSuite });
  const runToken = `${Date.now()}`;
  const sessionPrefix = `electron-playwright-${runToken}`;
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-electron-config-'));
  writeTestConfig(configDirectory);
  let instance: ElectronTestInstance | undefined;
  let sessionsCleaned = false;

  try {
    instance = await launchApp(sessionPrefix, configDirectory);
    await runFirstLaunchChecks(instance, sessionPrefix, runToken);
    await closeInstance(instance);
    instance = undefined;

    instance = await launchApp(sessionPrefix, configDirectory);
    await verifyPersistedSettingsShortcut(instance.page);
    await closeInstance(instance);
    instance = undefined;

    const persistedState = parseJson<PersistedTestState>(
      fs.readFileSync(path.join(configDirectory, 'state.json'), 'utf8'),
      'persisted state',
    );
    assert(
      persistedState.window.width === 1400 && persistedState.window.height === 900,
      `window state was not persisted: ${JSON.stringify(persistedState.window)}`,
    );
    assert(persistedState.schemaVersion === 3, 'workspace state schema was not persisted');
    assert(persistedState.activeWorkspaceId === 'review', 'active workspace was not persisted');
    assert(
      JSON.stringify(Object.keys(persistedState.workspaceLayouts).sort()) === JSON.stringify(['default', 'review']),
      'renderer did not persist seeded workspace layouts',
    );
    const configBackupPath = path.join(configDirectory, 'config.json.bak');
    const changedBackup = parseJson<DesktopConfig>(
      fs.readFileSync(configBackupPath, 'utf8'),
      'configuration backup',
    );
    const defaultShellProfile = changedBackup.launchProfiles['default-shell'];
    assert(defaultShellProfile, 'configuration backup omitted default-shell launch profile');
    defaultShellProfile.cwd = '/changed-after-start';
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
    await runWorkspaceCatalogCheck(runToken);
    await runPersistentTabCheck(runToken);
    await runPaneLayoutCheck(runToken);
    await runCloseConfirmationCheck(runToken);
    await runKillPolicyCheck(runToken);
    await runInvalidConfigurationCheck(runToken);
    log('passed');
  } catch (error) {
    log('failed', { message: errorMessage(error), consoleMessages: instance?.consoleMessages || [] });
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
