'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_LIMIT = 20;
const MAX_DAILY_LIMIT = 1000;

function parseDailyLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DAILY_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_DAILY_LIMIT;
  return Math.min(parsed, MAX_DAILY_LIMIT);
}

function createDailyBudgetGuard({ getPool, getLimiter, getLimit }) {
  if (typeof getPool !== 'function' || typeof getLimiter !== 'function') {
    throw new TypeError('Daily AI budget guard requires pool and limiter providers.');
  }
  return function aiDailyBudget(req, res, next) {
    if (!getPool()) {
      return res.status(503).json({
        error: 'AI requests are paused because persistent PostgreSQL storage is unavailable. Configure DATABASE_URL to enable the daily AI usage limit safely.'
      });
    }
    const maxRequests = parseDailyLimit(typeof getLimit === 'function' ? getLimit() : undefined);
    return getLimiter('ai-daily-budget', maxRequests, DAY_MS, { shared: true })(req, res, next);
  };
}

module.exports = { DAY_MS, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT, parseDailyLimit, createDailyBudgetGuard };
