import assert = require('node:assert/strict');
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import {
  ensureLocalHubToken,
  ensureWslHubToken,
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
assert.deepEqual(invocation!.args.slice(0, 3), ['--exec', 'sh', '-c']);
assert(invocation!.args[3]!.includes('/dev/urandom'));
assert(invocation!.args[3]!.includes('mktemp'));
assert.equal(invocation!.options.windowsHide, true);

let createdInvocation: SpawnInvocation | undefined;
const created = ensureWslHubToken({
  spawn: (command, args, options) => {
    createdInvocation = { command, args, options };
    return { status: 0, stdout: `${TOKEN}\n`, stderr: '' };
  },
});
assert.deepEqual(created, { token: TOKEN, source: 'wsl' });
assert.equal(createdInvocation!.command, 'wsl.exe');
assert(createdInvocation!.args[3]!.includes('umask 077'));
assert(createdInvocation!.args[3]!.includes('chmod 600'));

{
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-token-loader-'));
  const local = loadHubToken({ env: { XDG_STATE_HOME: stateHome }, platform: 'linux' });
  assert.equal(local.source, 'local');
  assert.match(local.token, /^[0-9a-fA-F]{64}$/);
  assert.equal(
    fs.readFileSync(path.join(stateHome, 'neoncode', 'hub-token'), 'utf8').trim(),
    local.token,
  );
  assert.deepEqual(
    ensureLocalHubToken({ env: { XDG_STATE_HOME: stateHome } }),
    local,
  );
  fs.rmSync(stateHome, { recursive: true, force: true });
}
assert.throws(
  () => loadHubToken({
    env: {},
    platform: 'win32',
    spawn: () => ({ status: 2, stdout: '', stderr: 'hub token file is malformed' }),
  }),
  /malformed/,
);
assert.throws(
  () => ensureWslHubToken({
    spawn: () => ({ status: 0, stdout: 'not-a-token', stderr: '' }),
  }),
  /64 hexadecimal/,
);

console.log('token-loader tests passed');
