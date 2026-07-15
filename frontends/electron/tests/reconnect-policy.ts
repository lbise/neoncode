import assert = require('node:assert/strict');

import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectPolicy,
  activationFallback,
} from '../renderer/reconnect-policy';

type TimerHandle = ReturnType<typeof setTimeout>;

interface FakeTimer {
  callback: () => void;
  delay: number;
}

interface FakeTimers {
  timers: Map<TimerHandle, FakeTimer>;
  setTimer(callback: () => void, delay: number): TimerHandle;
  clearTimer(id: TimerHandle): void;
  fire(id: TimerHandle): void;
}

function fakeTimers(): FakeTimers {
  let nextId = 1;
  const timers = new Map<TimerHandle, FakeTimer>();
  return {
    timers,
    setTimer(callback: () => void, delay: number): TimerHandle {
      const id = nextId++ as unknown as TimerHandle;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id: TimerHandle): void {
      timers.delete(id);
    },
    fire(id: TimerHandle): void {
      const timer = timers.get(id);
      assert(timer, `missing fake timer ${String(id)}`);
      timers.delete(id);
      timer.callback();
    },
  };
}

function onlyTimer(clock: FakeTimers): [TimerHandle, FakeTimer] {
  const entry = [...clock.timers.entries()][0];
  assert(entry, 'missing fake timer');
  return entry;
}

function testCappedBackoffAndSingleTimer(): void {
  const clock = fakeTimers();
  const policy = new ReconnectPolicy({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const fired: number[] = [];
  const expected = [250, 500, 1000, 2000, 4000, 5000, 5000];
  for (const delay of expected) {
    const scheduled = policy.schedule(() => fired.push(policy.attempts));
    assert(scheduled);
    assert.equal(scheduled.delayMs, delay);
    assert.equal(clock.timers.size, 1);
    assert.equal(policy.schedule(() => {}), null, 'scheduled a duplicate reconnect timer');
    const [timerId, timer] = onlyTimer(clock);
    assert.equal(timer.delay, delay);
    clock.fire(timerId);
  }
  assert.equal(fired.length, expected.length);
  assert.equal(RECONNECT_INITIAL_DELAY_MS, 250);
  assert.equal(RECONNECT_MAX_DELAY_MS, 5000);
}

function testCancelAndReset(): void {
  const clock = fakeTimers();
  const policy = new ReconnectPolicy({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  policy.schedule(() => assert.fail('cancelled reconnect fired'));
  policy.cancel();
  assert.equal(clock.timers.size, 0);
  assert.equal(policy.attempts, 1, 'cancel should retain backoff history');
  policy.schedule(() => {});
  assert.equal(onlyTimer(clock)[1].delay, 500);
  policy.reset();
  assert.equal(clock.timers.size, 0);
  assert.equal(policy.attempts, 0);
  const scheduled = policy.schedule(() => {});
  assert(scheduled);
  assert.equal(scheduled.delayMs, 250);
}

function testActivationFallbackIsBounded(): void {
  assert.equal(activationFallback({
    mode: 'attach', message: 'unknown session: shell', alreadyUsed: false,
  }), 'start');
  assert.equal(activationFallback({
    mode: 'start', message: 'session already exists: shell', alreadyUsed: false,
  }), 'attach');
  assert.equal(activationFallback({
    mode: 'attach', message: 'unknown session: shell', alreadyUsed: true,
  }), null);
  assert.equal(activationFallback({
    mode: 'start', message: 'permission denied', alreadyUsed: false,
  }), null);
}

testCappedBackoffAndSingleTimer();
testCancelAndReset();
testActivationFallbackIsBounded();
console.log('reconnect-policy tests passed');
