'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT, parseDailyLimit, createDailyBudgetGuard } = require('../lib/ai-budget');

test('daily AI limit defaults to a conservative 20 requests', () => {
  assert.equal(parseDailyLimit(undefined), DEFAULT_DAILY_LIMIT);
  assert.equal(parseDailyLimit(''), DEFAULT_DAILY_LIMIT);
});

test('daily AI limit accepts positive integers and caps excessive values', () => {
  assert.equal(parseDailyLimit('7'), 7);
  assert.equal(parseDailyLimit('5000'), MAX_DAILY_LIMIT);
});

test('invalid daily AI limits fall back to the safe default', () => {
  for (const value of ['0', '-1', '1.5', 'not-a-number']) {
    assert.equal(parseDailyLimit(value), DEFAULT_DAILY_LIMIT);
  }
});

test('daily AI guard fails closed when PostgreSQL is unavailable', () => {
  let nextCalled = false;
  const middleware = createDailyBudgetGuard({
    getPool: () => null,
    getLimiter: () => { throw new Error('limiter must not run without persistent storage'); },
    getLimit: () => '10'
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  middleware({}, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /DATABASE_URL/);
  assert.equal(nextCalled, false);
});

test('daily AI guard applies one shared persistent 24-hour bucket', () => {
  let captured;
  const middleware = createDailyBudgetGuard({
    getPool: () => ({}),
    getLimiter: (...args) => { captured = args; return (_req, _res, next) => next(); },
    getLimit: () => '12'
  });
  let nextCalled = false;
  middleware({}, {}, () => { nextCalled = true; });
  assert.deepEqual(captured, ['ai-daily-budget', 12, DAY_MS]);
  assert.equal(nextCalled, true);
});
