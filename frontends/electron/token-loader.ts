import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

export const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

export type HubTokenSource = 'environment' | 'wsl';

export interface HubTokenResult {
  token: string;
  source: HubTokenSource;
}

export interface TokenCommandResult {
  error?: unknown;
  status: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export type TokenSpawn = (
  command: string,
  arguments_: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => TokenCommandResult;

export interface LoadHubTokenOptions {
  env?: unknown;
  platform?: unknown;
  spawn?: TokenSpawn;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function validateToken(token: unknown, source: string): string {
  const normalized = String(token || '').trim();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${source} must provide exactly 64 hexadecimal characters`);
  }
  return normalized;
}

export function loadHubToken({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
}: LoadHubTokenOptions = {}): HubTokenResult {
  if (!isRecord(env)) {
    throw new Error('hub token environment must be an object');
  }

  const environmentToken = env.NEONCODE_HUB_TOKEN;
  if (environmentToken) {
    return {
      token: validateToken(environmentToken, 'NEONCODE_HUB_TOKEN'),
      source: 'environment',
    };
  }
  if (platform !== 'win32') {
    throw new Error('NEONCODE_HUB_TOKEN is required outside the Windows desktop runtime');
  }

  const result = spawn(
    'wsl.exe',
    [
      '--exec',
      'sh',
      '-c',
      'token_file="${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token"; cat "$token_file"',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    },
  );
  if (result.error) {
    throw new Error(`failed to read the WSL hub token: ${errorMessage(result.error)}`);
  }
  if (result.status !== 0) {
    const detail = outputText(result.stderr).trim() || `wsl.exe exited ${String(result.status)}`;
    throw new Error(`failed to read the WSL hub token: ${detail}`);
  }
  return {
    token: validateToken(result.stdout, 'WSL hub token file'),
    source: 'wsl',
  };
}
