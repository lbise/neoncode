import fs = require('node:fs');
import path = require('node:path');
import {
  spawn,
  spawnSync,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

import { ensureLocalHubToken, ensureWslHubToken, type HubTokenResult } from './token-loader';

export type HubManagerStatus =
  | 'healthy'
  | 'started'
  | 'skipped'
  | 'missing-bundled-hub'
  | 'start-failed';

export interface HubManagerResult {
  status: HubManagerStatus;
  endpoint: string;
  healthUrl?: string;
  managed: boolean;
  warnings: string[];
  errors: string[];
  bundledHubPath?: string;
  wslHubPath?: string;
  pid?: number;
}

export interface ParsedHubEndpoint {
  endpoint: string;
  healthUrl: string;
  bindAddress: string;
  port: string;
  loopback: boolean;
  managed: boolean;
}

export interface HubHealthResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HubFetchOptions {
  method: 'GET';
  signal?: AbortSignal;
}

export type HubFetch = (url: string, options: HubFetchOptions) => Promise<HubHealthResponse>;

export interface HubCommandResult {
  error?: unknown;
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export type HubSpawnSync = (
  command: string,
  arguments_: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => HubCommandResult;

export interface HubStartedProcess {
  readonly pid: number | undefined;
  unref(): void;
}

export type HubSpawn = (
  command: string,
  arguments_: string[],
  options: SpawnOptions,
) => HubStartedProcess;

export type HubSleep = (milliseconds: number) => Promise<void>;

export interface ManageHubLifecycleOptions {
  endpoint: string;
  appVersion: string;
  appSha?: string;
  resourcesPath: string;
  bundledHubPath?: string;
  platform?: NodeJS.Platform;
  fetch?: HubFetch;
  spawn?: HubSpawn;
  spawnSync?: HubSpawnSync;
  sleep?: HubSleep;
  ensureToken?: () => HubTokenResult;
  pollAttempts?: number;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

type SpawnSyncOptions = SpawnSyncOptionsWithStringEncoding;

const DEFAULT_ENDPOINT_HOST = '127.0.0.1';
const DEFAULT_ENDPOINT_PATH = '/ws';
const HEALTH_PATH = '/health';
const DEFAULT_POLL_ATTEMPTS = 25;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;

const INSTALL_HUB_SCRIPT = `set -eu
version_label="$1"
source_path="$2"
install_dir="\${XDG_DATA_HOME:-$HOME/.local/share}/neoncode/hub"
destination="$install_dir/neoncode-hub-$version_label"
mkdir -p "$install_dir"
chmod 700 "$install_dir"
temporary="$destination.tmp.$$"
rm -f "$temporary"
cp "$source_path" "$temporary"
chmod 700 "$temporary"
mv -f "$temporary" "$destination"
printf '%s\n' "$destination"
`;

const START_HUB_SCRIPT = `set -eu
bind_address="$1"
hub_binary="$2"
if [ ! -x "$hub_binary" ]; then
  echo "managed hub binary is not executable: $hub_binary" >&2
  exit 126
fi
NEONCODE_HUB_BIND="$bind_address" exec "$hub_binary"
`;

function defaultFetch(url: string, options: HubFetchOptions): Promise<HubHealthResponse> {
  return fetch(url, options);
}

const defaultSpawn: HubSpawn = (command, arguments_, options) => {
  const child = spawn(command, arguments_, options);
  return {
    pid: child.pid,
    unref(): void {
      child.unref();
    },
  };
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function createResult(
  status: HubManagerStatus,
  parsed: ParsedHubEndpoint | null,
  endpoint: string,
  managed: boolean,
  warnings: string[],
  errors: string[],
  extra: Pick<HubManagerResult, 'bundledHubPath' | 'wslHubPath' | 'pid'> = {},
): HubManagerResult {
  const result: HubManagerResult = {
    status,
    endpoint,
    managed,
    warnings,
    errors,
  };
  if (parsed) result.healthUrl = parsed.healthUrl;
  if (extra.bundledHubPath !== undefined) result.bundledHubPath = extra.bundledHubPath;
  if (extra.wslHubPath !== undefined) result.wslHubPath = extra.wslHubPath;
  if (extra.pid !== undefined) result.pid = extra.pid;
  return result;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === DEFAULT_ENDPOINT_HOST
    || normalized.startsWith('127.');
}

function bindHostForEndpoint(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost') return DEFAULT_ENDPOINT_HOST;
  if (normalized.includes(':')) return `[${normalized}]`;
  return normalized;
}

export function parseHubEndpoint(endpoint: string): ParsedHubEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`hub endpoint is not a valid URL: ${errorMessage(error)}`);
  }
  const port = url.port;
  const loopback = isLoopbackHostname(url.hostname);
  const managed = url.protocol === 'ws:'
    && url.pathname === DEFAULT_ENDPOINT_PATH
    && port.length > 0
    && loopback
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === '';
  const healthUrl = new URL(endpoint);
  healthUrl.protocol = 'http:';
  healthUrl.pathname = HEALTH_PATH;
  healthUrl.search = '';
  healthUrl.hash = '';
  return {
    endpoint,
    healthUrl: healthUrl.toString(),
    bindAddress: `${bindHostForEndpoint(url.hostname)}:${port}`,
    port,
    loopback,
    managed,
  };
}

function sanitizedHubEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'NEONCODE_HUB_TOKEN' && value !== undefined) {
      environment[key] = value;
    }
  }
  const wslEnv = environment.WSLENV;
  if (wslEnv) {
    const filtered = wslEnv
      .split(':')
      .filter((entry) => entry.split('/')[0] !== 'NEONCODE_HUB_TOKEN')
      .join(':');
    if (filtered) {
      environment.WSLENV = filtered;
    } else {
      delete environment.WSLENV;
    }
  }
  return environment;
}

function spawnSyncOptions(
  timeout: number,
  environment: NodeJS.ProcessEnv,
): SpawnSyncOptions {
  return {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    env: environment,
  };
}

function assertCommandSucceeded(result: HubCommandResult, label: string): void {
  if (result.error) {
    throw new Error(`${label}: ${errorMessage(result.error)}`);
  }
  if (result.status !== 0) {
    const detail = outputText(result.stderr).trim() || `exit status ${String(result.status)}`;
    throw new Error(`${label}: ${detail}`);
  }
}

function resolveBundledHubPath(options: ManageHubLifecycleOptions): string {
  if (options.bundledHubPath) return options.bundledHubPath;
  return path.join(options.resourcesPath, 'hub', 'linux-x64', 'neoncode-hub');
}

function releaseLabel(appVersion: string, appSha: string | undefined): string {
  const raw = appSha && appSha.trim() ? appSha.trim() : appVersion;
  const normalized = raw.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

async function checkHubHealth(
  healthUrl: string,
  fetcher: HubFetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(healthUrl, { method: 'GET', signal: controller.signal });
    if (!response.ok || response.status !== 200) return false;
    const body = (await response.text()).trim();
    return body === 'ok' || body === '';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function windowsPathToWsl(
  sourcePath: string,
  spawnSyncImpl: HubSpawnSync,
  environment: NodeJS.ProcessEnv,
): string {
  const result = spawnSyncImpl(
    'wsl.exe',
    ['--exec', 'wslpath', '-a', sourcePath],
    spawnSyncOptions(15000, environment),
  );
  assertCommandSucceeded(result, 'resolve bundled hub path in WSL');
  const converted = outputText(result.stdout).trim();
  if (!converted) {
    throw new Error('resolve bundled hub path in WSL: wslpath returned an empty path');
  }
  return converted;
}

function installBundledHub(
  bundledHubPath: string,
  label: string,
  spawnSyncImpl: HubSpawnSync,
  environment: NodeJS.ProcessEnv,
): string {
  const wslSourcePath = windowsPathToWsl(bundledHubPath, spawnSyncImpl, environment);
  const result = spawnSyncImpl(
    'wsl.exe',
    ['--exec', 'sh', '-c', INSTALL_HUB_SCRIPT, 'sh', label, wslSourcePath],
    spawnSyncOptions(30000, environment),
  );
  assertCommandSucceeded(result, 'install bundled hub in WSL');
  const installedPath = outputText(result.stdout).trim();
  if (!installedPath.startsWith('/')) {
    throw new Error('install bundled hub in WSL: installer did not return an absolute WSL path');
  }
  return installedPath;
}

function startManagedWslHub(
  bindAddress: string,
  wslHubPath: string,
  spawnImpl: HubSpawn,
  environment: NodeJS.ProcessEnv,
): HubStartedProcess {
  return spawnImpl(
    'wsl.exe',
    ['--exec', 'sh', '-c', START_HUB_SCRIPT, 'sh', bindAddress, wslHubPath],
    {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: environment,
    },
  );
}

function startManagedNativeHub(
  bindAddress: string,
  hubPath: string,
  spawnImpl: HubSpawn,
  environment: NodeJS.ProcessEnv,
): HubStartedProcess {
  return spawnImpl(
    hubPath,
    [],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...environment,
        NEONCODE_HUB_BIND: bindAddress,
      },
    },
  );
}

export async function manageHubLifecycle(
  options: ManageHubLifecycleOptions,
): Promise<HubManagerResult> {
  const endpoint = options.endpoint;
  let parsed: ParsedHubEndpoint;
  try {
    parsed = parseHubEndpoint(endpoint);
  } catch (error) {
    return createResult(
      'skipped',
      null,
      endpoint,
      false,
      [`hub manager skipped invalid endpoint: ${errorMessage(error)}`],
      [],
    );
  }

  const fetcher = options.fetch ?? defaultFetch;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  if (await checkHubHealth(parsed.healthUrl, fetcher, healthTimeoutMs)) {
    return createResult('healthy', parsed, endpoint, parsed.managed, [], []);
  }

  if (!parsed.managed) {
    const warning = parsed.loopback
      ? `hub manager skipped unsupported endpoint ${endpoint}; only ws://127.0.0.1:<port>/ws can be started automatically`
      : `hub manager skipped non-loopback endpoint ${endpoint}`;
    return createResult('skipped', parsed, endpoint, false, [warning], []);
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'linux') {
    return createResult(
      'skipped',
      parsed,
      endpoint,
      true,
      [`hub manager skipped app-managed launch on unsupported platform ${platform}`],
      [],
    );
  }

  const bundledHubPath = resolveBundledHubPath(options);
  if (!fs.existsSync(bundledHubPath)) {
    const hubKind = platform === 'win32' ? 'bundled WSL hub binary' : 'bundled native hub binary';
    return createResult(
      'missing-bundled-hub',
      parsed,
      endpoint,
      true,
      [`${hubKind} is missing; app-managed hub launch skipped: ${bundledHubPath}`],
      [],
      { bundledHubPath },
    );
  }

  const spawnSyncImpl = options.spawnSync ?? spawnSync;
  const spawnImpl = options.spawn ?? defaultSpawn;
  const sleep = options.sleep ?? defaultSleep;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sourceEnvironment = options.env ?? process.env;
  const environment = sanitizedHubEnvironment(sourceEnvironment);

  try {
    const ensureToken = options.ensureToken ?? (platform === 'win32'
      ? (() => ensureWslHubToken({ spawn: spawnSyncImpl }))
      : (() => ensureLocalHubToken({ env: sourceEnvironment })));
    ensureToken();
    const wslHubPath = platform === 'win32'
      ? installBundledHub(
        bundledHubPath,
        releaseLabel(options.appVersion, options.appSha),
        spawnSyncImpl,
        environment,
      )
      : undefined;
    const child = platform === 'win32'
      ? startManagedWslHub(parsed.bindAddress, wslHubPath!, spawnImpl, environment)
      : startManagedNativeHub(parsed.bindAddress, bundledHubPath, spawnImpl, environment);
    const baseDetails: Pick<HubManagerResult, 'bundledHubPath' | 'wslHubPath' | 'pid'> = platform === 'win32'
      ? { bundledHubPath, wslHubPath: wslHubPath! }
      : { bundledHubPath };
    const startedDetails = child.pid === undefined
      ? baseDetails
      : { ...baseDetails, pid: child.pid };
    child.unref();
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (await checkHubHealth(parsed.healthUrl, fetcher, healthTimeoutMs)) {
        return createResult(
          'started',
          parsed,
          endpoint,
          true,
          [],
          [],
          startedDetails,
        );
      }
      await sleep(pollIntervalMs);
    }
    return createResult(
      'start-failed',
      parsed,
      endpoint,
      true,
      [],
      [`app-managed hub did not become healthy at ${parsed.healthUrl}`],
      startedDetails,
    );
  } catch (error) {
    return createResult(
      'start-failed',
      parsed,
      endpoint,
      true,
      [],
      [`app-managed hub launch failed: ${errorMessage(error)}`],
      { bundledHubPath },
    );
  }
}
