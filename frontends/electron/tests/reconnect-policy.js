const assert = require('node:assert/strict');

const {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectPolicy,
  activationFallback,
} = require('../renderer/reconnect-policy');

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire(id) {
      const timer = timers.get(id);
      assert(timer, `missing fake timer ${id}`);
      timers.delete(id);
      timer.callback();
    },
  };
}

function testCappedBackoffAndSingleTimer() {
  const clock = fakeTimers();
  const policy = new ReconnectPolicy({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const fired = [];
  const expected = [250, 500, 1000, 2000, 4000, 5000, 5000];
  for (const delay of expected) {
    const scheduled = policy.schedule(() => fired.push(policy.attempts));
    assert.equal(scheduled.delayMs, delay);
    assert.equal(clock.timers.size, 1);
    assert.equal(policy.schedule(() => {}), null, 'scheduled a duplicate reconnect timer');
    const [timerId, timer] = [...clock.timers.entries()][0];
    assert.equal(timer.delay, delay);
    clock.fire(timerId);
  }
  assert.equal(fired.length, expected.length);
  assert.equal(RECONNECT_INITIAL_DELAY_MS, 250);
  assert.equal(RECONNECT_MAX_DELAY_MS, 5000);
}

function testCancelAndReset() {
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
  assert.equal([...clock.timers.values()][0].delay, 500);
  policy.reset();
  assert.equal(clock.timers.size, 0);
  assert.equal(policy.attempts, 0);
  assert.equal(policy.schedule(() => {}).delayMs, 250);
}

function testActivationFallbackIsBounded() {
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
