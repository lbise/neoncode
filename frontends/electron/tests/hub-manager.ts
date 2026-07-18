import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import type { SpawnOptions, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import {
  manageHubLifecycle,
  parseHubEndpoint,
  type HubCommandResult,
  type HubFetch,
  type HubSpawn,
  type HubSpawnSync,
} from '../hub-manager';

const TOKEN = 'abcdef0123456789'.repeat(4);

function temporaryHubBinary(): { directory: string; binary: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-hub-manager-'));
  const binary = path.join(directory, 'neoncode-hub');
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
  return { directory, binary };
}

function healthSequence(values: boolean[]): HubFetch {
  let index = 0;
  return async () => {
    const healthy = values[Math.min(index, values.length - 1)] ?? false;
    index += 1;
    return {
      ok: healthy,
      status: healthy ? 200 : 503,
      async text(): Promise<string> {
        return healthy ? 'ok\n' : 'starting';
      },
    };
  };
}

async function run(): Promise<void> {
  const parsed = parseHubEndpoint('ws://127.0.0.1:44777/ws');
  assert.equal(parsed.healthUrl, 'http://127.0.0.1:44777/health');
  assert.equal(parsed.bindAddress, '127.0.0.1:44777');
  assert.equal(parsed.managed, true);
  assert.equal(parseHubEndpoint('ws://192.168.1.7:44777/ws').managed, false);

  {
    const result = await manageHubLifecycle({
      endpoint: 'ws://127.0.0.1:44777/ws',
      appVersion: '0.1.0',
      resourcesPath: '/missing',
      platform: 'win32',
      fetch: healthSequence([true]),
    });
    assert.equal(result.status, 'healthy');
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors.length, 0);
  }

  {
    const result = await manageHubLifecycle({
      endpoint: 'ws://192.168.1.7:44777/ws',
      appVersion: '0.1.0',
      resourcesPath: '/missing',
      platform: 'win32',
      fetch: healthSequence([false]),
    });
    assert.equal(result.status, 'skipped');
    assert(result.warnings[0]!.includes('non-loopback'));
  }

  {
    const result = await manageHubLifecycle({
      endpoint: 'ws://127.0.0.1:44777/ws',
      appVersion: '0.1.0',
      resourcesPath: '/missing',
      platform: 'win32',
      fetch: healthSequence([false]),
    });
    assert.equal(result.status, 'missing-bundled-hub');
    assert(result.warnings[0]!.includes('bundled WSL hub binary is missing'));
  }

  {
    const { directory, binary } = temporaryHubBinary();
    const syncInvocations: Array<{ command: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding }> = [];
    const spawnInvocations: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const fakeSpawnSync: HubSpawnSync = (command, args, options): HubCommandResult => {
      syncInvocations.push({ command, args, options });
      if (args[1] === 'wslpath') {
        return { status: 0, stdout: '/mnt/c/NeonCode/resources/hub/linux-x64/neoncode-hub\n', stderr: '' };
      }
      return { status: 0, stdout: '/home/dev/.local/share/neoncode/hub/neoncode-hub-8ab2118\n', stderr: '' };
    };
    const fakeSpawn: HubSpawn = (command, args, options) => {
      spawnInvocations.push({ command, args, options });
      return {
        pid: 4242,
        unref(): void {},
      };
    };

    const result = await manageHubLifecycle({
      endpoint: 'ws://127.0.0.1:44777/ws',
      appVersion: '0.1.0',
      appSha: '8ab2118',
      resourcesPath: directory,
      bundledHubPath: binary,
      platform: 'win32',
      fetch: healthSequence([false, false, true]),
      spawnSync: fakeSpawnSync,
      spawn: fakeSpawn,
      sleep: async () => {},
      ensureToken: () => ({ token: TOKEN, source: 'wsl' }),
      env: { NEONCODE_HUB_TOKEN: TOKEN, WSLENV: 'FOO:NEONCODE_HUB_TOKEN/u:BAR' },
      pollAttempts: 5,
      pollIntervalMs: 1,
    });

    assert.equal(result.status, 'started');
    assert.equal(result.pid, 4242);
    assert.equal(result.wslHubPath, '/home/dev/.local/share/neoncode/hub/neoncode-hub-8ab2118');
    assert.equal(syncInvocations.length, 2);
    assert.equal(spawnInvocations.length, 1);
    assert.deepEqual(spawnInvocations[0]!.args.slice(0, 3), ['--exec', 'sh', '-c']);
    assert(spawnInvocations[0]!.args.includes('127.0.0.1:44777'));
    assert(!spawnInvocations[0]!.args.join(' ').includes(TOKEN));
    assert.equal(spawnInvocations[0]!.options.env!.NEONCODE_HUB_TOKEN, undefined);
    assert.equal(spawnInvocations[0]!.options.env!.WSLENV, 'FOO:BAR');
    assert(syncInvocations.every((invocation) => invocation.command === 'wsl.exe'));
    fs.rmSync(directory, { recursive: true, force: true });
  }

  {
    const { directory, binary } = temporaryHubBinary();
    const spawnInvocations: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const fakeSpawn: HubSpawn = (command, args, options) => {
      spawnInvocations.push({ command, args, options });
      return {
        pid: 5151,
        unref(): void {},
      };
    };

    const result = await manageHubLifecycle({
      endpoint: 'ws://127.0.0.1:44777/ws',
      appVersion: '0.1.0',
      resourcesPath: directory,
      bundledHubPath: binary,
      platform: 'linux',
      fetch: healthSequence([false, true]),
      spawn: fakeSpawn,
      sleep: async () => {},
      ensureToken: () => ({ token: TOKEN, source: 'local' }),
      env: { NEONCODE_HUB_TOKEN: TOKEN, PATH: '/usr/bin' },
      pollAttempts: 3,
      pollIntervalMs: 1,
    });

    assert.equal(result.status, 'started');
    assert.equal(result.pid, 5151);
    assert.equal(result.bundledHubPath, binary);
    assert.equal(result.wslHubPath, undefined);
    assert.equal(spawnInvocations.length, 1);
    assert.equal(spawnInvocations[0]!.command, binary);
    assert.deepEqual(spawnInvocations[0]!.args, []);
    assert.equal(spawnInvocations[0]!.options.env!.NEONCODE_HUB_BIND, '127.0.0.1:44777');
    assert.equal(spawnInvocations[0]!.options.env!.NEONCODE_HUB_TOKEN, undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  {
    const { directory, binary } = temporaryHubBinary();
    const failingSpawnSync: HubSpawnSync = (command, args, options) => {
      void command;
      void args;
      void options;
      return { status: 1, stdout: '', stderr: 'cp failed' };
    };
    const result = await manageHubLifecycle({
      endpoint: 'ws://127.0.0.1:44777/ws',
      appVersion: '0.1.0',
      resourcesPath: directory,
      bundledHubPath: binary,
      platform: 'win32',
      fetch: healthSequence([false]),
      spawnSync: failingSpawnSync,
      ensureToken: () => ({ token: TOKEN, source: 'wsl' }),
    });
    assert.equal(result.status, 'start-failed');
    assert(result.errors[0]!.includes('cp failed'));
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log('hub-manager tests passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
