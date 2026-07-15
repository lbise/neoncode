import assert = require('node:assert/strict');
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import {
  loadHubToken,
  type HubTokenResult,
  type TokenSpawn,
} from '../token-loader';

interface SpawnInvocation {
  command: string;
  args: string[];
  options: SpawnSyncOptionsWithStringEncoding;
}

const TOKEN = '0123456789abcdef'.repeat(4);

assert.deepEqual(
  loadHubToken({ env: { NEONCODE_HUB_TOKEN: TOKEN }, platform: 'linux' }),
  { token: TOKEN, source: 'environment' },
);

let invocation: SpawnInvocation | undefined;
const recordingSpawn: TokenSpawn = (command, args, options) => {
  invocation = { command, args, options };
  return { status: 0, stdout: `${TOKEN}\r\n`, stderr: '' };
};
const fromWsl: HubTokenResult = loadHubToken({
  env: {},
  platform: 'win32',
  spawn: recordingSpawn,
});
assert.deepEqual(fromWsl, { token: TOKEN, source: 'wsl' });
assert.equal(invocation!.command, 'wsl.exe');
assert(invocation!.args.includes('--exec'));
assert.equal(invocation!.options.windowsHide, true);

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
