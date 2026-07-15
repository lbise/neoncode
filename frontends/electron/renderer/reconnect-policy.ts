import type { ActivationMode } from '../shared/types';

export const RECONNECT_INITIAL_DELAY_MS = 250;
export const RECONNECT_MAX_DELAY_MS = 5000;

interface ActivationFallbackOptions {
  mode: ActivationMode;
  message: string;
  alreadyUsed: boolean;
}

export function activationFallback({
  mode,
  message,
  alreadyUsed,
}: ActivationFallbackOptions): ActivationMode | null {
  if (alreadyUsed) return null;
  if (mode === 'attach' && message.includes('unknown session')) return 'start';
  if (mode === 'start' && message.includes('session already exists')) return 'attach';
  return null;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

interface ReconnectPolicyOptions {
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

export interface ReconnectSchedule {
  attempts: number;
  delayMs: number;
}

export class ReconnectPolicy {
  readonly setTimer: SetTimer;
  readonly clearTimer: ClearTimer;
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  attempts = 0;
  private timer: TimerHandle | undefined;

  constructor({
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
    initialDelayMs = RECONNECT_INITIAL_DELAY_MS,
    maximumDelayMs = RECONNECT_MAX_DELAY_MS,
  }: ReconnectPolicyOptions = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.initialDelayMs = initialDelayMs;
    this.maximumDelayMs = maximumDelayMs;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  schedule(callback: () => void): ReconnectSchedule | null {
    if (this.pending) return null;
    this.attempts += 1;
    const delayMs = Math.min(
      this.initialDelayMs * (2 ** (this.attempts - 1)),
      this.maximumDelayMs,
    );
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      callback();
    }, delayMs);
    return { attempts: this.attempts, delayMs };
  }

  cancel(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  reset(): void {
    this.cancel();
    this.attempts = 0;
  }
}
