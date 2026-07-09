const { _electron: electron } = require('playwright');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const endpoint = process.env.NEONCODE_HUB_ENDPOINT || 'ws://127.0.0.1:44777/ws';
const timeout = Number.parseInt(process.env.NEONCODE_PLAYWRIGHT_TIMEOUT || '15000', 10);

function log(message, details) {
  const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[xterm-smoke] ${message}${payload}`);
}

async function main() {
  log('launch', { appRoot, endpoint });
  const sessionPrefix = `electron-xterm-playwright-${Date.now()}`;
  const electronApp = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    env: {
      ...process.env,
      NEONCODE_HUB_ENDPOINT: endpoint,
      NEONCODE_TERMINAL_COUNT: process.env.NEONCODE_TERMINAL_COUNT || '2',
      NEONCODE_SESSION_PREFIX: sessionPrefix,
    },
  });

  const consoleMessages = [];
  try {
    const page = await electronApp.firstWindow({ timeout });
    page.on('console', (message) => {
      const text = message.text();
      consoleMessages.push(text);
      log('console', text);
    });

    await page.waitForSelector('[data-testid="app-header"]', { timeout });
    await page.waitForSelector('[data-testid="terminal-pane-1"]', { timeout });
    await page.waitForSelector('[data-testid="terminal-pane-2"]', { timeout });

    await page.waitForFunction(() => window.neoncodeXtermState?.panes?.length >= 2, null, { timeout });
    await page.waitForFunction(() => window.neoncodeXtermState.panes[0]?.started === true, null, { timeout });
    await page.waitForFunction(() => window.neoncodeXtermState.panes[1]?.started === true, null, { timeout });
    await page.waitForFunction(() => window.neoncodeXtermState.panes[0]?.outputEvents > 0, null, { timeout });
    await page.waitForFunction(() => window.neoncodeXtermState.panes[1]?.outputEvents > 0, null, { timeout });

    const state = await page.evaluate(() => JSON.parse(JSON.stringify(window.neoncodeXtermState)));
    log('state.ready', state);

    const beforeInputEvents = await page.evaluate(() => window.neoncodeXtermState.panes[0].inputEvents);
    await page.locator('[data-testid="terminal-1"]').click();
    await page.keyboard.type('echo xtermsmokeplaywright');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      (before) => window.neoncodeXtermState.panes[0].inputEvents > before,
      beforeInputEvents,
      { timeout },
    );
    await page.waitForFunction(
      () => window.neoncodeXtermState.panes[0].lastSmokeMarkerCount > 0,
      null,
      { timeout },
    );

    const finalState = await page.evaluate(() => JSON.parse(JSON.stringify(window.neoncodeXtermState)));
    log('state.final', finalState);
    log('passed');
  } catch (error) {
    log('failed', { message: error.message, consoleMessages });
    throw error;
  } finally {
    await electronApp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
