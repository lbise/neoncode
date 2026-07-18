import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import crypto = require('node:crypto');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

export const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

export type HubTokenSource = 'environment' | 'wsl' | 'local';

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

export interface EnsureWslHubTokenOptions {
  spawn?: TokenSpawn;
}

export interface EnsureLocalHubTokenOptions {
  env?: unknown;
}

export interface LoadHubTokenOptions {
  env?: unknown;
  platform?: unknown;
  spawn?: TokenSpawn;
}

type UnknownRecord = Record<string, unknown>;

const ENSURE_WSL_TOKEN_SCRIPT = `set -eu
token_file="\${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token"
token_dir=$(dirname "$token_file")
umask 077
mkdir -p "$token_dir"
chmod 700 "$token_dir"
if [ -L "$token_file" ]; then
  echo "hub token path must not be a symlink: $token_file" >&2
  exit 2
fi
if [ -e "$token_file" ]; then
  if [ ! -f "$token_file" ]; then
    echo "hub token path must be a regular file: $token_file" >&2
    exit 2
  fi
  token=$(tr -d '\r\n' < "$token_file")
  case "$token" in
    *[!0123456789abcdefABCDEF]*|'')
      echo "hub token file is malformed: expected 64 hexadecimal characters" >&2
      exit 2
      ;;
  esac
  if [ \${#token} -ne 64 ]; then
    echo "hub token file is malformed: expected 64 hexadecimal characters" >&2
    exit 2
  fi
  chmod 600 "$token_file"
  printf '%s\n' "$token"
  exit 0
fi
token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
temporary=$(mktemp "$token_dir/.hub-token.tmp.XXXXXX")
if ! printf '%s\n' "$token" > "$temporary"; then
  rm -f "$temporary"
  exit 1
fi
chmod 600 "$temporary"
mv -f "$temporary" "$token_file"
printf '%s\n' "$token"
`;

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

function envString(env: UnknownRecord, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function currentUserId(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwnedByCurrentUser(stat: fs.Stats, label: string): void {
  const uid = currentUserId();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function localTokenPath(env: UnknownRecord): string {
  const stateHome = envString(env, 'XDG_STATE_HOME');
  if (stateHome) return path.join(stateHome, 'neoncode', 'hub-token');
  const home = envString(env, 'HOME') ?? os.homedir();
  if (!home) {
    throw new Error('HOME is unavailable for the managed hub token file');
  }
  return path.join(home, '.local', 'state', 'neoncode', 'hub-token');
}

export function ensureLocalHubToken({ env = process.env }: EnsureLocalHubTokenOptions = {}): HubTokenResult {
  if (!isRecord(env)) {
    throw new Error('hub token environment must be an object');
  }

  const tokenPath = localTokenPath(env);
  const tokenDirectory = path.dirname(tokenPath);
  fs.mkdirSync(tokenDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(tokenDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`hub token directory must be a real directory: ${tokenDirectory}`);
  }
  assertOwnedByCurrentUser(directoryStat, `hub token directory ${tokenDirectory}`);
  fs.chmodSync(tokenDirectory, 0o700);

  try {
    const tokenStat = fs.lstatSync(tokenPath);
    if (tokenStat.isSymbolicLink()) {
      throw new Error(`hub token path must not be a symlink: ${tokenPath}`);
    }
    if (!tokenStat.isFile()) {
      throw new Error(`hub token path must be a regular file: ${tokenPath}`);
    }
    assertOwnedByCurrentUser(tokenStat, `hub token file ${tokenPath}`);
    const token = validateToken(fs.readFileSync(tokenPath, 'utf8'), 'managed hub token file');
    fs.chmodSync(tokenPath, 0o600);
    return { token, source: 'local' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const temporaryPath = path.join(tokenDirectory, `.hub-token.tmp.${String(process.pid)}.${crypto.randomBytes(6).toString('hex')}`);
  const file = fs.openSync(temporaryPath, 'wx', 0o600);
  try {
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8' });
  } finally {
    fs.closeSync(file);
  }
  fs.renameSync(temporaryPath, tokenPath);
  fs.chmodSync(tokenPath, 0o600);
  return { token, source: 'local' };
}

export function ensureWslHubToken({
  spawn = spawnSync,
}: EnsureWslHubTokenOptions = {}): HubTokenResult {
  const result = spawn(
    'wsl.exe',
    ['--exec', 'sh', '-c', ENSURE_WSL_TOKEN_SCRIPT],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    },
  );
  if (result.error) {
    throw new Error(`failed to ensure the WSL hub token: ${errorMessage(result.error)}`);
  }
  if (result.status !== 0) {
    const detail = outputText(result.stderr).trim() || `wsl.exe exited ${String(result.status)}`;
    throw new Error(`failed to ensure the WSL hub token: ${detail}`);
  }
  return {
    token: validateToken(result.stdout, 'WSL hub token file'),
    source: 'wsl',
  };
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
  if (platform === 'win32') {
    return ensureWslHubToken({ spawn });
  }

  return ensureLocalHubToken({ env });
}
