const assert = require('node:assert/strict');

const { loadHubToken } = require('../token-loader');

const TOKEN = '0123456789abcdef'.repeat(4);

assert.deepEqual(
  loadHubToken({ env: { NEONCODE_HUB_TOKEN: TOKEN }, platform: 'linux' }),
  { token: TOKEN, source: 'environment' },
);

let invocation;
const fromWsl = loadHubToken({
  env: {},
  platform: 'win32',
  spawn(command, args, options) {
    invocation = { command, args, options };
    return { status: 0, stdout: `${TOKEN}\r\n`, stderr: '' };
  },
});
assert.deepEqual(fromWsl, { token: TOKEN, source: 'wsl' });
assert.equal(invocation.command, 'wsl.exe');
assert(invocation.args.includes('--exec'));
assert.equal(invocation.options.windowsHide, true);

assert.throws(
  () => loadHubToken({ env: {}, platform: 'linux' }),
  /required outside/,
);
assert.throws(
  () => loadHubToken({
    env: {},
    platform: 'win32',
    spawn: () => ({ status: 1, stdout: '', stderr: 'missing token' }),
  }),
  /missing token/,
);

console.log('token-loader tests passed');
