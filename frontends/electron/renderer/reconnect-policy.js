const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;

function activationFallback({ mode, message, alreadyUsed }) {
  if (alreadyUsed) return null;
  if (mode === 'attach' && message.includes('unknown session')) return 'start';
  if (mode === 'start' && message.includes('session already exists')) return 'attach';
  return null;
}

class ReconnectPolicy {
  constructor({
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    initialDelayMs = RECONNECT_INITIAL_DELAY_MS,
    maximumDelayMs = RECONNECT_MAX_DELAY_MS,
  } = {}) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.initialDelayMs = initialDelayMs;
    this.maximumDelayMs = maximumDelayMs;
    this.attempts = 0;
    this.timer = undefined;
  }

  get pending() {
    return this.timer !== undefined;
  }

  schedule(callback) {
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

  cancel() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  reset() {
    this.cancel();
    this.attempts = 0;
  }
}

module.exports = {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectPolicy,
  activationFallback,
};
