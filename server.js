require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'app-data.json');
const sessions = new Map();
const attempts = new Map();
let requestCount = 0;
let storageReady = false;
const DEFAULT_STATE = {
  opportunities: [], campaigns: [], content: [], revenue: [], approvals: [], automationRuns: [], aiUsage: [], optimizationReports: [], golfOpportunities: [], products: [], orders: [], subscriptions: [], leads: [], suppliers: [],
  settings: { niche: '', monthlyGoal: 500, autonomy: 'approval', strategies: ['affiliate', 'digital-products', 'lead-generation', 'content'] },
  activity: []
};
app.disable('x-powered-by');
// Render terminates TLS at its edge proxy. Trust only the nearest proxy hop so req.ip
// resolves the actual client address without trusting user-supplied leftmost XFF values.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Stripe webhooks require the unmodified request body for signature verification.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook is not configured.');
    if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) return res.status(503).send('Live Stripe keys are disabled in this build.');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    const next = structuredClone(state);
    const now = new Date().toISOString();
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const existing = next.orders.find(x => x.checkoutSessionId === session.id);
      const order = {
        id: existing?.id || session.id, checkoutSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        customerId: typeof session.customer === 'string' ? session.customer : null,
        customerEmail: session.customer_details?.email || session.customer_email || '',
        productId: session.metadata?.productId || '',
        productName: session.metadata?.productName || '',
        mode: session.mode, amountTotal: Number(session.amount_total || 0) / 100,
        currency: String(session.currency || 'usd').toUpperCase(),
        paymentStatus: session.payment_status || 'unknown',
        fulfillmentStatus: existing?.fulfillmentStatus || 'pending',
        deliveryToken: existing?.deliveryToken || (session.metadata?.productType === 'digital' ? crypto.randomBytes(32).toString('hex') : null),
        status: 'paid', updatedAt: now, createdAt: existing?.createdAt || now
      };
      if (existing) Object.assign(existing, order); else next.orders.unshift(order);
      if (order.paymentStatus === 'paid' && !next.revenue.some(x => x.checkoutSessionId === session.id)) {
        next.revenue.unshift({ id: crypto.randomUUID(), checkoutSessionId: session.id, type: 'Income', amount: order.amountTotal, source: 'Stripe sale: ' + (order.productName || 'Product') + ' (' + order.currency + ')', date: now.slice(0, 10), recordedAt: now });
      }
      if (session.mode === 'subscription' && session.subscription) {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        if (!next.subscriptions.some(x => x.stripeSubscriptionId === subId)) next.subscriptions.unshift({
          stripeSubscriptionId: subId, customerId: order.customerId, customerEmail: order.customerEmail,
          status: 'active', productName: order.productName, createdAt: now
        });
      }
    } else if (event.type.startsWith('customer.subscription.')) {
      const sub = event.data.object;
      const subId = sub.id;
      const record = next.subscriptions.find(x => x.stripeSubscriptionId === subId);
      const updated = { stripeSubscriptionId: subId, customerId: typeof sub.customer === 'string' ? sub.customer : null,
        status: sub.status, currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end), updatedAt: now };
      if (record) Object.assign(record, updated); else next.subscriptions.unshift(updated);
    } else if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const record = next.orders.find(x => x.checkoutSessionId === session.id);
      if (record) { record.status = 'expired'; record.updatedAt = now; }
    }
    next.activity.unshift({ message: 'Stripe event processed: ' + event.type, at: now });
    await saveState(next);
    // Send a digital delivery email only after Stripe confirms payment. Retries are idempotent.
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const paidOrder = state.orders.find(x => x.checkoutSessionId === event.data.object.id);
      if (paidOrder && paidOrder.paymentStatus === 'paid' && paidOrder.deliveryToken && paidOrder.customerEmail && paidOrder.deliveryEmailStatus !== 'sent') {
        await sendDigitalDeliveryEmail(paidOrder);
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error.message);
    res.status(400).send('Webhook signature verification failed.');
  }
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC, { index: false }));

let pool = null;
let state = structuredClone(DEFAULT_STATE);
const STATE_LISTS = ['opportunities', 'campaigns', 'content', 'revenue', 'approvals', 'automationRuns', 'aiUsage', 'optimizationReports', 'golfOpportunities', 'products', 'orders', 'subscriptions', 'leads', 'suppliers', 'activity'];
const ALLOWED_STRATEGIES = ['affiliate', 'digital-products', 'lead-generation', 'content', 'services'];
function sanitizeJson(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 10000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (depth >= 6) return [];
    return value.slice(0, 100).map(item => sanitizeJson(item, depth + 1));
  }
  if (value && typeof value === 'object' && depth < 6) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (!key || key.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      result[key] = sanitizeJson(item, depth + 1);
    }
    return result;
  }
  return null;
}
function cleanState(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = structuredClone(DEFAULT_STATE);
  for (const key of STATE_LISTS) {
    const rows = Array.isArray(v[key]) ? v[key].slice(-500) : [];
    out[key] = rows.map(row => sanitizeJson(row))
      .filter(row => row && typeof row === 'object' && !Array.isArray(row));
  }
  const settings = v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings) ? v.settings : {};
  out.settings = {
    niche: String(settings.niche || '').slice(0, 160),
    monthlyGoal: Number.isFinite(Number(settings.monthlyGoal)) ? Math.max(0, Math.min(Number(settings.monthlyGoal), 100000000)) : 500,
    autonomy: settings.autonomy === 'draft' ? 'draft' : 'approval',
    strategies: Array.isArray(settings.strategies) ? [...new Set(settings.strategies.filter(x => ALLOWED_STRATEGIES.includes(x)))].slice(0, ALLOWED_STRATEGIES.length) : [...DEFAULT_STATE.settings.strategies]
  };
  return out;
}
async function initStorage() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000 });
    await pool.query('CREATE TABLE IF NOT EXISTS autorevenue_ai_state (id integer PRIMARY KEY CHECK (id = 1), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS autorevenue_ai_sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS autorevenue_ai_rate_limits (bucket_key text PRIMARY KEY, hit_count integer NOT NULL, reset_at timestamptz NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS autorevenue_ai_backups (id bigserial PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
    const result = await pool.query('SELECT payload FROM autorevenue_ai_state WHERE id = 1');
    if (result.rows[0]) state = cleanState(result.rows[0].payload);
    else {
      let legacy = structuredClone(DEFAULT_STATE);
      try { if (fs.existsSync(DATA_FILE)) legacy = cleanState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (error) { console.warn('Legacy JSON migration skipped:', error.message); }
      state = legacy;
      await pool.query('INSERT INTO autorevenue_ai_state (id, payload) VALUES (1, $1)', [state]);
      console.log('Initial PostgreSQL state created; imported legacy JSON records when available.');
    }
    await pool.query('DELETE FROM autorevenue_ai_sessions WHERE expires_at < now()');
    storageReady = true;
    console.log('Persistent PostgreSQL storage connected.');
  } else {
    try { state = cleanState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch { state = structuredClone(DEFAULT_STATE); }
    storageReady = true;
    console.warn('DATABASE_URL is not configured: using local JSON storage. Data may not survive a Render restart or redeploy.');
  }
}
let saveQueue = Promise.resolve();
function saveState(next) {
  const normalized = cleanState(next);
  const write = async () => {
    if (pool) {
      const prior = await pool.query('SELECT updated_at FROM autorevenue_ai_state WHERE id = 1');
      const lastBackup = prior.rows[0]?.updated_at ? new Date(prior.rows[0].updated_at).getTime() : 0;
      if (prior.rows[0] && Date.now() - lastBackup >= 24 * 60 * 60 * 1000) {
        const snapshot = await pool.query('SELECT payload FROM autorevenue_ai_state WHERE id = 1');
        if (snapshot.rows[0]) await pool.query('INSERT INTO autorevenue_ai_backups (payload) VALUES ($1)', [snapshot.rows[0].payload]);
        await pool.query('DELETE FROM autorevenue_ai_backups WHERE id NOT IN (SELECT id FROM autorevenue_ai_backups ORDER BY created_at DESC LIMIT 14)');
      }
      await pool.query('INSERT INTO autorevenue_ai_state (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()', [normalized]);
    } else {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2));
    }
    state = normalized;
    return state;
  };
  const pending = saveQueue.then(write);
  saveQueue = pending.catch(() => {});
  return pending;
}
async function recordAIUsage(completion, purpose) {
  try {
    const usage = completion?.usage || {};
    const next = structuredClone(state);
    next.aiUsage = Array.isArray(next.aiUsage) ? next.aiUsage : [];
    next.aiUsage.unshift({
      id: crypto.randomUUID(),
      purpose: String(purpose || 'AI request').slice(0, 80),
      model: String(process.env.OPENAI_MODEL || '').slice(0, 120),
      promptTokens: Math.max(0, Number(usage.prompt_tokens) || 0),
      completionTokens: Math.max(0, Number(usage.completion_tokens) || 0),
      totalTokens: Math.max(0, Number(usage.total_tokens) || 0),
      estimatedCostUsd: Number(((Math.max(0, Number(usage.prompt_tokens) || 0) * (Number(process.env.OPENAI_INPUT_USD_PER_1M) || 0) + Math.max(0, Number(usage.completion_tokens) || 0) * (Number(process.env.OPENAI_OUTPUT_USD_PER_1M) || 0)) / 1000000).toFixed(6)),
      createdAt: new Date().toISOString()
    });
    next.aiUsage = next.aiUsage.slice(0, 500);
    await saveState(next);
  } catch (error) {
    console.error('AI usage tracking failed:', error.message);
  }
}
function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
function limited(bucket, max, windowMs) {
  return async (req, res, next) => {
    const key = bucket + ':' + clientIp(req), now = Date.now();
    try {
      if (pool) {
        const result = await pool.query(
          "INSERT INTO autorevenue_ai_rate_limits (bucket_key, hit_count, reset_at) VALUES ($1, 1, now() + ($2 * interval '1 millisecond')) ON CONFLICT (bucket_key) DO UPDATE SET hit_count = CASE WHEN autorevenue_ai_rate_limits.reset_at <= now() THEN 1 ELSE autorevenue_ai_rate_limits.hit_count + 1 END, reset_at = CASE WHEN autorevenue_ai_rate_limits.reset_at <= now() THEN now() + ($2 * interval '1 millisecond') ELSE autorevenue_ai_rate_limits.reset_at END RETURNING hit_count",
          [key, windowMs]
        );
        if (Number(result.rows[0]?.hit_count || 0) > max) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
      } else {
        requestCount++;
        if (requestCount % 100 === 0) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
        const entry = attempts.get(key) || { count: 0, reset: now + windowMs };
        if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
        entry.count++; attempts.set(key, entry);
        if (entry.count > max) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
      }
      next();
    } catch (error) { console.error('Rate limit storage failed:', error.message); res.status(503).json({ error: 'Request protection is temporarily unavailable.' }); }
  };
}
async function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  sessions.set(token, expiresAt.getTime());
  if (pool) await pool.query('INSERT INTO autorevenue_ai_sessions (token_hash, expires_at) VALUES ($1, $2)', [crypto.createHash('sha256').update(token).digest('hex'), expiresAt]);
  return token;
}
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Please sign in again.' });
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    let valid = false;
    if (pool) { const result = await pool.query('SELECT 1 FROM autorevenue_ai_sessions WHERE token_hash = $1 AND expires_at > now()', [hash]); valid = result.rowCount > 0; }
    else { const expires = sessions.get(token); valid = Boolean(expires && expires > Date.now()); }
    if (!valid) { sessions.delete(token); return res.status(401).json({ error: 'Please sign in again.' }); }
    req.sessionToken = token; next();
  } catch (error) { console.error('Session validation failed:', error.message); res.status(503).json({ error: 'Session service temporarily unavailable.' }); }
}
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'AutoRevenue AI', version: '2.0.0',
  authConfigured: Boolean(process.env.ADMIN_PASSWORD),
  stripeTestConfigured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')),
  stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  emailDeliveryConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
  aiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
  persistentStorage: Boolean(process.env.DATABASE_URL), storageMode: pool ? 'postgres' : 'local-json', storageReady, sessionStorage: pool ? 'postgres' : 'memory', aiCostRatesConfigured: Number(process.env.OPENAI_INPUT_USD_PER_1M) > 0 && Number(process.env.OPENAI_OUTPUT_USD_PER_1M) > 0
}));
app.post('/api/login', limited('login', 10, 15 * 60 * 1000), async (req, res) => {
  const password = String(req.body?.password || '');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin sign-in is not configured. Add ADMIN_PASSWORD in Render environment variables.' });
  const expected = Buffer.from(process.env.ADMIN_PASSWORD), supplied = Buffer.from(password);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(401).json({ error: 'Incorrect password.' });
  try { res.json({ token: await createSession() }); } catch (error) { console.error('Session creation failed:', error.message); res.status(503).json({ error: 'Could not create a secure session.' }); }
});
app.post('/api/logout', requireAuth, async (req, res) => { sessions.delete(req.sessionToken); if (pool) await pool.query('DELETE FROM autorevenue_ai_sessions WHERE token_hash = $1', [crypto.createHash('sha256').update(req.sessionToken).digest('hex')]); res.json({ ok: true }); });

async function sendDigitalDeliveryEmail(order) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.log('Digital delivery email skipped: RESEND_API_KEY or EMAIL_FROM is not configured.');
    return { sent: false, reason: 'not_configured' };
  }
  const next = structuredClone(state);
  const current = next.orders.find(x => x.checkoutSessionId === order.checkoutSessionId);
  if (!current || current.deliveryEmailStatus === 'sent') return { sent: Boolean(current?.deliveryEmailStatus === 'sent') };
  const product = next.products.find(x => x.id === current.productId && x.type === 'digital');
  if (!product || !product.deliveryContent) return { sent: false, reason: 'missing_product_content' };
  const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) return { sent: false, reason: 'missing_app_base_url' };
  const downloadUrl = baseUrl + '/download/' + current.deliveryToken;
  const subject = 'Your download: ' + (product.name || 'Your digital purchase');
  const html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;line-height:1.6;color:#172033"><h2>Thank you for your purchase</h2><p>Your payment is confirmed. Your digital product is ready.</p><p><a href="' + downloadUrl + '" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Download your product</a></p><p>If the button does not work, copy this link into your browser:</p><p>' + downloadUrl + '</p><p>Thank you,<br>AutoRevenue</p></div>';
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [current.customerEmail], subject, html })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Email provider returned HTTP ' + response.status + (result.message ? ': ' + result.message : ''));
    current.deliveryEmailStatus = 'sent';
    current.deliveryEmailId = String(result.id || '');
    current.deliveryEmailSentAt = new Date().toISOString();
    current.deliveryEmailError = '';
    await saveState(next);
    console.log('Digital delivery email sent for order ' + current.checkoutSessionId);
    return { sent: true };
  } catch (error) {
    current.deliveryEmailStatus = 'failed';
    current.deliveryEmailError = String(error.message || 'Email send failed').slice(0, 500);
    current.deliveryEmailAttemptedAt = new Date().toISOString();
    await saveState(next);
    console.error('Digital delivery email failed:', error.message);
    return { sent: false, reason: 'send_failed' };
  }
}
function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured. Add STRIPE_SECRET_KEY in Render.');
  if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Only Stripe test-mode keys are accepted by this build.');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
async function getStripeTransactionSnapshot(stripe) {
  const [balance, balanceTransactions, charges, payouts] = await Promise.all([
    stripe.balance.retrieve(),
    stripe.balanceTransactions.list({ limit: 100 }),
    stripe.charges.list({ limit: 100 }),
    stripe.payouts.list({ limit: 100 })
  ]);
  const chargeById = new Map(charges.data.map(charge => [charge.id, charge]));
  const transactions = balanceTransactions.data.map(tx => {
    const sourceId = typeof tx.source === 'string' ? tx.source : tx.source?.id || '';
    const charge = chargeById.get(sourceId);
    return {
      id: tx.id,
      type: String(tx.type || 'other'),
      description: String(tx.description || charge?.description || ''),
      amount: tx.amount / 100,
      fee: tx.fee / 100,
      net: tx.net / 100,
      currency: String(tx.currency || 'usd').toUpperCase(),
      status: String(tx.status || 'unknown'),
      created: tx.created,
      availableOn: tx.available_on || null,
      sourceId,
      customerEmail: charge?.billing_details?.email || charge?.receipt_email || '',
      paymentIntentId: typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id || '',
      paymentStatus: charge?.status || '',
      refunded: charge ? charge.amount_refunded / 100 : null
    };
  });
  const paidOrders = (state.orders || []).filter(order => order.paymentStatus === 'paid');
  const orderByPaymentIntent = new Map(paidOrders.filter(order => order.paymentIntentId).map(order => [order.paymentIntentId, order]));
  const matchedOrderIds = new Set();
  const matchedTransactionIds = new Set();
  for (const tx of transactions) {
    const order = tx.paymentIntentId ? orderByPaymentIntent.get(tx.paymentIntentId) : null;
    if (order && ['charge', 'payment'].includes(tx.type) && tx.amount > 0) {
      matchedOrderIds.add(order.id);
      matchedTransactionIds.add(tx.id);
    }
  }
  const currencyTotals = rows => rows.reduce((out, row) => {
    const currency = String(row.currency || 'USD').toUpperCase();
    out[currency] = Number(((out[currency] || 0) + Number(row.amount || 0)).toFixed(2));
    return out;
  }, {});
  const paidPayouts = payouts.data.filter(p => p.status === 'paid');
  const pendingPayouts = payouts.data.filter(p => ['pending', 'in_transit'].includes(p.status));
  const reconciliation = {
    paidOrderCount: paidOrders.length,
    matchedOrderCount: matchedOrderIds.size,
    unmatchedPaidOrderCount: paidOrders.length - matchedOrderIds.size,
    unmatchedPaidOrders: paidOrders.filter(order => !matchedOrderIds.has(order.id)).map(order => ({
      id: order.id, productName: order.productName || 'Stripe order',
      amount: Number(order.amountTotal || 0), currency: String(order.currency || 'USD').toUpperCase(),
      paymentIntentId: order.paymentIntentId || '', createdAt: order.createdAt || ''
    })),
    unmatchedStripePaymentCount: transactions.filter(tx => ['charge', 'payment'].includes(tx.type) && tx.amount > 0 && !matchedTransactionIds.has(tx.id)).length,
    paidOrderTotals: currencyTotals(paidOrders.map(order => ({ amount: order.amountTotal, currency: order.currency }))),
    paidPayoutCount: paidPayouts.length,
    paidPayoutTotals: currencyTotals(paidPayouts),
    pendingPayoutCount: pendingPayouts.length,
    pendingPayoutTotals: currencyTotals(pendingPayouts),
    failedPayoutCount: payouts.data.filter(p => ['failed', 'canceled'].includes(p.status)).length,
    note: 'Payouts are transfers of Stripe funds, not additional sales. Unmatched items may reflect webhook timing, older than the 100-record retrieval window, or payments created outside this app.'
  };
  return {
    mode: 'test',
    currency: 'USD',
    reconciliation,
    balance: {
      available: balance.available.map(x => ({ currency: x.currency.toUpperCase(), amount: x.amount / 100 })),
      pending: balance.pending.map(x => ({ currency: x.currency.toUpperCase(), amount: x.amount / 100 }))
    },
    transactions,
    payouts: payouts.data.map(p => ({
      id: p.id, amount: p.amount / 100, currency: p.currency.toUpperCase(),
      status: p.status, arrivalDate: p.arrival_date, created: p.created,
      method: p.method, type: p.type, description: p.description || ''
    })),
    hasMoreTransactions: balanceTransactions.has_more,
    hasMoreCharges: charges.has_more,
    hasMorePayouts: payouts.has_more,
    fetchedAt: new Date().toISOString()
  };
}
app.get('/api/commerce/products', requireAuth, (req, res) => res.json({ products: state.products || [] }));
app.get('/api/commerce/orders', requireAuth, (req, res) => res.json({ orders: state.orders || [], subscriptions: state.subscriptions || [] }));
app.post('/api/commerce/orders/:orderId/resend-email', requireAuth, limited('delivery-email-retry', 10, 60 * 60 * 1000), async (req, res) => {
  const orderId = String(req.params.orderId || '');
  const order = (state.orders || []).find(x => x.id === orderId || x.checkoutSessionId === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.paymentStatus !== 'paid') return res.status(409).json({ error: 'Only paid orders can receive digital delivery.' });
  if (!order.deliveryToken || !order.customerEmail) return res.status(409).json({ error: 'This order is missing its digital delivery token or customer email.' });
  if (order.deliveryEmailStatus === 'sent') return res.status(409).json({ error: 'This delivery email is already marked sent.' });
  const product = (state.products || []).find(x => x.id === order.productId && x.type === 'digital');
  if (!product || !product.deliveryContent) return res.status(409).json({ error: 'The digital product content is unavailable.' });
  const result = await sendDigitalDeliveryEmail(order);
  const updated = (state.orders || []).find(x => x.checkoutSessionId === order.checkoutSessionId);
  if (!result.sent) return res.status(502).json({ error: updated?.deliveryEmailError || 'Email delivery could not be completed.', order: updated || order });
  res.json({ ok: true, order: updated || order });
});
app.get('/api/commerce/checkout-session', requireAuth, limited('checkout-verify', 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim();
    if (!/^cs_test_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: 'A valid Stripe test checkout session ID is required.' });
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    if (session.livemode) return res.status(403).json({ error: 'Live-mode checkout sessions are not accepted by this test service.' });
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) return res.json({ ok: true, verified: false, paymentStatus: session.payment_status || 'pending', order: null });
    const next = structuredClone(state);
    const now = new Date().toISOString();
    const existing = next.orders.find(x => x.checkoutSessionId === session.id);
    const productId = session.metadata?.productId || '';
    const product = next.products.find(x => x.id === productId);
    const order = {
      id: existing?.id || session.id, checkoutSessionId: session.id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      customerEmail: session.customer_details?.email || session.customer_email || '',
      productId, productName: session.metadata?.productName || product?.name || 'Stripe order',
      mode: session.mode, amountTotal: Number(session.amount_total || 0) / 100,
      currency: String(session.currency || 'usd').toUpperCase(),
      paymentStatus: session.payment_status, fulfillmentStatus: existing?.fulfillmentStatus || 'pending',
      deliveryToken: existing?.deliveryToken || (session.metadata?.productType === 'digital' ? crypto.randomBytes(32).toString('hex') : null),
      status: 'paid', updatedAt: now, createdAt: existing?.createdAt || now
    };
    if (existing) Object.assign(existing, order); else next.orders.unshift(order);
    if (!next.revenue.some(x => x.checkoutSessionId === session.id)) {
      next.revenue.unshift({ id: crypto.randomUUID(), checkoutSessionId: session.id, type: 'Income', amount: order.amountTotal, source: 'Stripe sale: ' + order.productName + ' (' + order.currency + ')', date: now.slice(0, 10), recordedAt: now });
    }
    if (session.mode === 'subscription' && session.subscription) {
      const sub = session.subscription;
      const subId = typeof sub === 'string' ? sub : sub.id;
      const subStatus = typeof sub === 'object' ? sub.status : 'active';
      const prior = next.subscriptions.find(x => x.stripeSubscriptionId === subId);
      const subRecord = { stripeSubscriptionId: subId, customerId: order.customerId, customerEmail: order.customerEmail, status: subStatus || 'active', productName: order.productName, createdAt: prior?.createdAt || now, updatedAt: now };
      if (prior) Object.assign(prior, subRecord); else next.subscriptions.unshift(subRecord);
    }
    if (!existing) next.activity.unshift({ message: 'Stripe checkout verified and order recorded: ' + order.productName, at: now });
    await saveState(next);
    // Checkout verification is also a successful-payment path (for example, when
    // the customer returns to the success page before a webhook is processed).
    // Send digital fulfillment here too; sendDigitalDeliveryEmail skips orders
    // already marked as sent, preventing a second email after the webhook arrives.
    if (order.paymentStatus === 'paid' && order.deliveryToken && order.customerEmail) {
      await sendDigitalDeliveryEmail(order);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, verified: true, paymentStatus: order.paymentStatus, order });
  } catch (error) {
    console.error('Stripe checkout verification failed:', error.message);
    res.status(502).json({ error: 'Could not verify this Stripe test checkout. Check the session ID, Stripe test key, and Render logs.' });
  }
});

app.get('/api/stripe/transactions', requireAuth, limited('stripe-transactions', 6, 5 * 60 * 1000), async (req, res) => {
  try {
    const snapshot = await getStripeTransactionSnapshot(getStripeClient());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...snapshot });
  } catch (error) {
    console.error('Stripe transaction history failed:', error.message);
    res.status(502).json({ error: 'Could not load Stripe test transaction history. Check the Stripe test key and Render logs.' });
  }
});
app.get('/download/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).send('Download not found.');
  const order = (state.orders || []).find(x => x.deliveryToken === token && x.paymentStatus === 'paid');
  if (!order) return res.status(404).send('Download not found or payment not verified.');
  const product = (state.products || []).find(x => x.id === order.productId && x.type === 'digital');
  if (!product || !product.deliveryContent) return res.status(404).send('The digital file has not been prepared for this product.');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + String(product.name || 'digital-product').replace(/[^a-z0-9_-]/gi, '-').slice(0, 60) + '.txt"');
  res.send(product.deliveryContent);
});
app.post('/api/commerce/orders/:orderId/fulfill', requireAuth, async (req, res) => {
  try {
    const next = structuredClone(state);
    const order = next.orders.find(x => x.id === req.params.orderId || x.checkoutSessionId === req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.paymentStatus !== 'paid') return res.status(409).json({ error: 'Only paid orders can be marked fulfilled.' });
    order.fulfillmentStatus = 'fulfilled';
    order.fulfilledAt = new Date().toISOString();
    order.updatedAt = order.fulfilledAt;
    next.activity.unshift({ message: 'Marked order fulfilled: ' + (order.productName || order.checkoutSessionId), at: order.fulfilledAt });
    await saveState(next);
    res.json({ order });
  } catch (error) { console.error('Order fulfillment update failed:', error.message); res.status(500).json({ error: 'Could not update order.' }); }
});
app.post('/api/commerce/products', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 160);
    const description = String(body.description || '').trim().slice(0, 2000);
    const deliveryContent = String(body.deliveryContent || '').trim().slice(0, 50000);
    const type = body.type === 'physical' ? 'physical' : 'digital';
    const billing = body.billing === 'subscription' ? 'subscription' : 'one_time';
    const amount = Number(body.amount);
    const interval = ['month', 'year'].includes(body.interval) ? body.interval : 'month';
    if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter a product name and a valid positive price.' });
    if (billing === 'subscription' && type === 'physical') return res.status(400).json({ error: 'Recurring physical-product orders are not enabled yet. Use one-time checkout for shipped goods.' });
    if (type === 'digital' && !deliveryContent) return res.status(400).json({ error: 'Add the digital product content customers should receive after payment.' });
    const product = { id: crypto.randomUUID(), name, description, deliveryContent: type === 'digital' ? deliveryContent : '', type, billing, amount: Math.round(amount * 100) / 100, currency: 'usd', interval: billing === 'subscription' ? interval : null, active: true, createdAt: new Date().toISOString() };
    const next = structuredClone(state); next.products.unshift(product);
    next.activity.unshift({ message: 'Created commerce product: ' + name, at: product.createdAt });
    await saveState(next);
    res.status(201).json({ product });
  } catch (error) { console.error('Product create failed:', error.message); res.status(500).json({ error: 'Could not save product.' }); }
});
app.post('/api/commerce/checkout', requireAuth, limited('checkout', 30, 60 * 60 * 1000), async (req, res) => {
  try {
    const product = (state.products || []).find(x => x.id === String(req.body?.productId || '') && x.active);
    if (!product) return res.status(404).json({ error: 'Active product not found.' });
    const stripe = getStripeClient();
    const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl || !/^https:\/\//i.test(baseUrl)) return res.status(503).json({ error: 'Set APP_BASE_URL to the HTTPS AutoRevenue AI test URL in Render.' });
    const session = await stripe.checkout.sessions.create({
      mode: product.billing === 'subscription' ? 'subscription' : 'payment',
      line_items: [{ price_data: {
        currency: product.currency || 'usd',
        product_data: { name: product.name, description: product.description || undefined, metadata: { productId: product.id, productType: product.type } },
        unit_amount: Math.round(Number(product.amount) * 100),
        ...(product.billing === 'subscription' ? { recurring: { interval: product.interval || 'month' } } : {})
      }, quantity: 1 }],
      customer_email: typeof req.body?.email === 'string' && req.body.email.includes('@') ? req.body.email.slice(0, 254) : undefined,
      success_url: baseUrl + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: baseUrl + '/?checkout=cancelled',
      allow_promotion_codes: true,
      billing_address_collection: product.type === 'physical' ? 'required' : 'auto',
      shipping_address_collection: product.type === 'physical' ? { allowed_countries: ['US'] } : undefined,
      metadata: { productId: product.id, productName: product.name, productType: product.type, billing: product.billing }
    });
    res.json({ url: session.url, sessionId: session.id, mode: session.mode, testMode: true });
  } catch (error) { console.error('Stripe checkout creation failed:', error.message); res.status(502).json({ error: error.message || 'Could not create Stripe Checkout session.' }); }
});
app.post('/api/commerce/portal', requireAuth, async (req, res) => {
  try {
    const customerId = String(req.body?.customerId || '').trim();
    if (!customerId.startsWith('cus_')) return res.status(400).json({ error: 'A valid Stripe customer ID is required.' });
    const stripe = getStripeClient();
    const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl || !/^https:\/\//i.test(baseUrl)) return res.status(503).json({ error: 'Set APP_BASE_URL to the HTTPS AutoRevenue AI test URL in Render.' });
    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: baseUrl });
    res.json({ url: portal.url });
  } catch (error) { console.error('Stripe portal creation failed:', error.message); res.status(502).json({ error: 'Could not create subscription management session.' }); }
});
app.get('/api/state/export', requireAuth, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="autorevenue-ai-backup-' + stamp + '.json"');
  res.send(JSON.stringify(state, null, 2));
});
// Public lead intake: explicit consent, honeypot and rate limit. Leads are never shared automatically.
app.post('/api/public/leads', limited('public-lead', 4, 60 * 60 * 1000), async (req, res) => {
  try {
    const body = req.body || {};
    if (String(body.website || '').trim()) return res.status(200).json({ ok: true, message: 'Request received.' });
    const name = String(body.name || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const phone = String(body.phone || '').trim().slice(0, 40);
    const zip = String(body.zip || '').trim().slice(0, 10);
    const equipment = String(body.equipment || '').trim().slice(0, 100);
    const model = String(body.model || '').trim().slice(0, 120);
    const attachment = String(body.attachment || '').trim().slice(0, 160);
    const timeline = String(body.timeline || '').trim().slice(0, 80);
    const details = String(body.details || '').trim().slice(0, 1500);
    const source = String(body.source || 'Direct').trim().slice(0, 100);
    const utmSource = String(body.utmSource || '').trim().slice(0, 100);
    const utmMedium = String(body.utmMedium || '').trim().slice(0, 100);
    const utmCampaign = String(body.utmCampaign || '').trim().slice(0, 120);

    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\\.[^\s@]+$/.test(email) || !/^\d{5}(-\d{4})?$/.test(zip)) return res.status(400).json({ error: 'Enter your name, a valid email address and a 5-digit ZIP code.' });
    if (!attachment || !timeline || !['Immediately','Within 30 days','1–3 months','Just researching'].includes(timeline)) return res.status(400).json({ error: 'Choose an attachment and purchase timeline.' });
    if (body.consent !== true) return res.status(400).json({ error: 'Consent is required so we can respond to your request.' });
    const score = (phone ? 15 : 0) + (equipment ? 20 : 0) + (model ? 15 : 0) + (timeline === 'Immediately' ? 35 : timeline === 'Within 30 days' ? 25 : timeline === '1–3 months' ? 15 : 5) + (attachment ? 15 : 0);
    // Schedule an internal reminder only; this never sends an email or shares buyer data.
    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + (timeline === 'Immediately' ? 0 : timeline === 'Within 30 days' ? 1 : timeline === '1–3 months' ? 3 : 7));
    const followUpAt = followUpDate.toISOString().slice(0, 10);
    const lead = { id: crypto.randomUUID(), name, email, phone, zip, equipment, model, attachment, timeline, details, source, utmSource, utmMedium, utmCampaign, consent: true, consentText: 'Agreed to be contacted about this request and to have details shared with a matched equipment supplier if one is found.', score, status: score >= 70 ? 'Qualified' : 'New', followUpAt, followUpNote: '', referralStatus: 'Unmatched', matchedSupplierId: '', sharingApprovedAt: '', createdAt: new Date().toISOString() };
    const next = structuredClone(state);
    next.leads = Array.isArray(next.leads) ? next.leads : [];
    next.leads.unshift(lead);
    next.leads = next.leads.slice(0, 500);
    next.activity.unshift({ message: 'New equipment buyer lead received (' + lead.status + ')', at: lead.createdAt });
    await saveState(next);
    res.status(201).json({ ok: true, message: 'Your request has been received. We will review your equipment details.' });
  } catch (error) { console.error('Public lead intake failed:', error.message); res.status(500).json({ error: 'We could not save your request. Please try again.' }); }
});
app.get('/api/leads', requireAuth, (req, res) => res.json({ leads: state.leads || [] }));
app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  const allowed = ['New','Qualified','Contacted','Converted','Closed'];
  const next = structuredClone(state), lead = (next.leads || []).find(x => x.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  if (req.body?.status !== undefined) { const status = String(req.body.status); if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid lead status.' }); lead.status = status; }
  if (req.body?.followUpAt !== undefined) { const value = String(req.body.followUpAt || ''); if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({ error: 'Follow-up date must be YYYY-MM-DD.' }); lead.followUpAt = value; }
  if (req.body?.followUpNote !== undefined) lead.followUpNote = String(req.body.followUpNote || '').trim().slice(0, 500);
  if (req.body?.sharingApproved === true) { if (lead.consent !== true) return res.status(409).json({ error: 'Buyer consent is not recorded.' }); lead.sharingApprovedAt = new Date().toISOString(); }
  if (req.body?.matchedSupplierId !== undefined) { const supplierId = String(req.body.matchedSupplierId || ''); if (supplierId && !(next.suppliers || []).some(x => x.id === supplierId && x.status === 'Active')) return res.status(400).json({ error: 'Select an active supplier.' }); lead.matchedSupplierId = supplierId; lead.referralStatus = supplierId ? 'Candidate' : 'Unmatched'; }
  if (req.body?.referralStatus !== undefined) { const allowedReferral = ['Unmatched','Candidate','Approved to Share','Sent','Accepted','Rejected','Converted','Fee Received']; const value = String(req.body.referralStatus); if (!allowedReferral.includes(value)) return res.status(400).json({ error: 'Invalid referral status.' }); if (['Approved to Share','Sent','Accepted','Converted','Fee Received'].includes(value) && !lead.sharingApprovedAt) return res.status(409).json({ error: 'Approve buyer-information sharing first.' }); lead.referralStatus = value; }
  if (req.body?.referralFeeReceived !== undefined) { const amount = Number(req.body.referralFeeReceived); if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter a valid referral payment amount.' }); if (lead.referralStatus !== 'Converted') return res.status(409).json({ error: 'Mark the referral Converted before recording received payment.' }); if (lead.referralFeeReceivedAt) return res.status(409).json({ error: 'Referral payment has already been recorded.' }); lead.referralFeeReceived = amount; lead.referralFeeReceivedAt = new Date().toISOString(); next.revenue.unshift({ id: crypto.randomUUID(), type: 'Income', amount, source: 'Verified referral fee received · Lead ' + lead.id, date: new Date().toISOString().slice(0,10), referralLeadId: lead.id, recordedAt: new Date().toISOString() }); lead.referralStatus = 'Fee Received'; }
  lead.updatedAt = new Date().toISOString(); await saveState(next); res.json({ ok: true, lead });
});
app.get('/api/suppliers', requireAuth, (req, res) => res.json({ suppliers: state.suppliers || [] }));
app.post('/api/suppliers', requireAuth, async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0,160);
  if (!name) return res.status(400).json({ error: 'Supplier name is required.' });
  const supplier = { id: crypto.randomUUID(), name, contactName: String(b.contactName || '').trim().slice(0,120), email: String(b.email || '').trim().slice(0,254), phone: String(b.phone || '').trim().slice(0,40), website: String(b.website || '').trim().slice(0,300), zipCodes: String(b.zipCodes || '').split(/[\s,;]+/).filter(x => /^\d{5}$/.test(x)).slice(0,100), regions: String(b.regions || '').trim().slice(0,300), equipment: String(b.equipment || '').trim().slice(0,300), attachments: String(b.attachments || '').trim().slice(0,300), feeModel: ['fixed','percent','negotiated'].includes(b.feeModel) ? b.feeModel : 'negotiated', feeAmount: Math.max(0, Math.min(100000, Number(b.feeAmount) || 0)), agreementStatus: b.agreementStatus === 'Agreed' ? 'Agreed' : 'Pending', status: 'Active', createdAt: new Date().toISOString() };
  const next = structuredClone(state); next.suppliers.unshift(supplier); await saveState(next); res.status(201).json({ supplier });
});
app.patch('/api/suppliers/:id', requireAuth, async (req, res) => {
  const next = structuredClone(state), supplier = (next.suppliers || []).find(x => x.id === req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });
  if (req.body?.status !== undefined) { if (!['Active','Inactive'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid supplier status.' }); supplier.status = req.body.status; }
  if (req.body?.agreementStatus !== undefined) { if (!['Pending','Agreed'].includes(req.body.agreementStatus)) return res.status(400).json({ error: 'Invalid agreement status.' }); supplier.agreementStatus = req.body.agreementStatus; }
  supplier.updatedAt = new Date().toISOString(); await saveState(next); res.json({ supplier });
});
app.get('/api/leads/follow-ups', requireAuth, (req, res) => { const today = new Date().toISOString().slice(0,10); res.json({ leads: (state.leads || []).filter(x => x.followUpAt && x.followUpAt <= today && !['Closed','Converted'].includes(x.status)) }); });
app.get('/api/state', requireAuth, (req, res) => res.json(state));
app.put('/api/state', requireAuth, limited('state-write', 120, 60 * 1000), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid workspace data.' });
    await saveState(req.body); res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (error) { console.error('State save failed:', error.message); res.status(500).json({ error: 'Could not save workspace data.' }); }
});
app.post('/api/ai/test', requireAuth, limited('ai-test', 3, 10 * 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
    return res.status(503).json({ ok: false, error: 'AI configuration is incomplete. Check OPENAI_API_KEY and OPENAI_MODEL in Render.' });
  }
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: AutoRevenue AI connection successful.' }],
      max_completion_tokens: 40
    });
    const result = completion.choices?.[0]?.message?.content?.trim() || '';
    if (!result) throw new Error('The model returned an empty response.');
    res.json({ ok: true, model: process.env.OPENAI_MODEL, message: 'OpenAI API request succeeded.' });
  } catch (error) {
    const status = Number(error.status || error.statusCode || 0);
    console.error('AI connection test failed:', status, error.message);
    const message = status === 401 ? 'OpenAI rejected the API key. Check the key in Render.'
      : status === 403 ? 'OpenAI denied access to this model or project. Check project permissions.'
      : status === 404 ? 'The configured model was not found or is not available to this API project.'
      : status === 429 ? 'OpenAI rate limit or billing limit reached. Check API usage and billing.'
      : status >= 500 ? 'OpenAI is temporarily unavailable. Try again shortly.'
      : 'AI connection failed. Check the configured model and Render logs.';
    res.status(502).json({ ok: false, error: message });
  }
});

app.post('/api/generate', requireAuth, limited('generate', 30, 60 * 60 * 1000), async (req, res) => {
  const { type = 'content', prompt = '', niche = '' } = req.body || {};
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'AI is not configured. Add OPENAI_API_KEY in Render environment variables.' });
  if (!process.env.OPENAI_MODEL) return res.status(503).json({ error: 'Set OPENAI_MODEL to a model available to your API project.' });
  if (typeof prompt !== 'string' || prompt.length > 6000) return res.status(400).json({ error: 'Prompt must be 6,000 characters or fewer.' });
  try {
    const OpenAI = require('openai'), client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = 'You are AutoRevenue AI, a practical business strategy and marketing assistant. Create original, lawful, realistic business materials. Do not promise earnings or fabricate market research, prices, audience sizes, affiliate terms, or performance data. Clearly label assumptions and distinguish estimates from verified facts. Prioritize low-cost experiments, customer value, and measurable validation. Never claim that you published, purchased, contacted, or executed anything.';
    const user = 'Task type: ' + String(type).slice(0, 80) + '\nNiche: ' + String(niche).slice(0, 160) + '\nRequest: ' + (prompt || 'Suggest a practical next step.');
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: 1800
    });
    const result = completion.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error('The model returned an empty response.');
    await recordAIUsage(completion, 'Content generation');
     res.json({ result, model: process.env.OPENAI_MODEL });
  } catch (error) {
    console.error('AI generation failed:', error.message);
    res.status(502).json({ error: 'AI generation failed. Check OPENAI_MODEL, API project access, and Render logs.' });
  }
});


app.post('/api/experiments/build', requireAuth, limited('experiment-build', 5, 60 * 60 * 1000), async (req,res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return res.status(503).json({error:'AI is not configured. Check the test service settings.'});
  const opportunityId=String(req.body?.opportunityId||'').slice(0,100);
  const opportunity=(state.opportunities||[]).find(x=>String(x.id)===opportunityId);
  if(!opportunity) return res.status(404).json({error:'Saved opportunity not found. Refresh the workspace and try again.'});
  try {
    const OpenAI=require('openai'),client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:90000,maxRetries:0});
    const system='You are a rigorous small-business experiment designer. Return only valid JSON. Use only supplied opportunity details and clearly label every estimate or hypothesis. Do not invent verified market prices, demand, customer counts, conversion rates, margins, sales or earnings. Never treat a hypothetical price or threshold as actual. Prefer a 7-day, zero-spend validation test. No spam, deceptive claims, unsolicited messages, or sharing personal data. Any paid activity, customer contact, publication, or external action requires owner approval.';
    const prompt='Design a practical experiment for this saved opportunity: '+JSON.stringify({title:opportunity.title,customer:opportunity.customer,problem:opportunity.problem,offer:opportunity.offer,monetization:opportunity.monetization,startupCostLow:opportunity.startupCostLow,startupCostHigh:opportunity.startupCostHigh,validationDays:opportunity.validationDays,validationSteps:opportunity.validationSteps,assumptions:opportunity.assumptions,mainRisk:opportunity.mainRisk,confidence:opportunity.confidence})+'. Return JSON with exactly: {"targetCustomer":"...","problem":"...","offer":"...","pricingHypothesis":"... label as unverified","costModel":{"oneTimeCostEstimateUSD":0,"variableCostPerSaleEstimateUSD":0,"priceHypothesisUSD":0,"breakEvenSalesAtHypothesis":0,"formula":"...","assumptions":["..."]},"sevenDayPlan":[{"day":1,"task":"...","evidenceToCapture":"..."}],"successThreshold":"measurable proposed threshold, explicitly a test assumption","failureOrPivotThreshold":"measurable proposed threshold, explicitly a test assumption","campaign":{"name":"...","channel":"...","goal":"...","draft":"..."},"content":{"title":"...","type":"...","draft":"..."},"risks":["..."],"nextAction":"..."}. Use 7 daily entries. If costs/prices are unknown, use zero/null where needed and explain missing inputs; do not manufacture numeric precision. Keep all copy truthful and label the campaign/content as drafts.';
    const completion=await client.chat.completions.create({model:process.env.OPENAI_MODEL,messages:[{role:'system',content:system},{role:'user',content:prompt}],max_completion_tokens:1800});
    let raw=(completion.choices?.[0]?.message?.content||'').trim().replace(/^`{3}(?:json)?s*/i,'').replace(/s*`{3}$/,'');
    const plan=JSON.parse(raw);
    if(typeof plan.targetCustomer!=='string'||!Array.isArray(plan.sevenDayPlan)||!plan.campaign||!plan.content) throw new Error('Experiment planner returned incomplete structured data.');
    plan.sevenDayPlan=plan.sevenDayPlan.slice(0,7).map((x,i)=>({day:i+1,task:String(x.task||'').slice(0,500),evidenceToCapture:String(x.evidenceToCapture||'').slice(0,400)}));
    if(plan.sevenDayPlan.length!==7||plan.sevenDayPlan.some(x=>!x.task)) throw new Error('Experiment planner did not return seven usable daily steps.');
    const saved={id:crypto.randomUUID(),opportunityId:opportunity.id,opportunityTitle:opportunity.title,createdAt:new Date().toISOString(),status:'Draft · validation required',plan};
    const next=structuredClone(state);next.experiments=Array.isArray(next.experiments)?next.experiments:[];
    next.experiments.unshift(saved);next.experiments=next.experiments.slice(0,50);
    next.campaigns=Array.isArray(next.campaigns)?next.campaigns:[];
    next.content=Array.isArray(next.content)?next.content:[];
    next.campaigns.unshift({id:Date.now(),name:String(plan.campaign.name||'Validation experiment').slice(0,160),channel:String(plan.campaign.channel||'To decide').slice(0,80),goal:String(plan.campaign.goal||'Validate demand').slice(0,300),duration:'7 days',plan:String(plan.campaign.draft||'').slice(0,5000),status:'Draft · owner review required',sourceExperimentId:saved.id,created:new Date().toISOString()});
    next.content.unshift({id:Date.now()+1,title:String(plan.content.title||'Experiment content draft').slice(0,180),type:String(plan.content.type||'Experiment draft').slice(0,80),body:String(plan.content.draft||'').slice(0,8000),status:'Draft · not published',sourceExperimentId:saved.id,created:new Date().toISOString()});
    next.activity=[{message:'Built a seven-day validation experiment for '+opportunity.title,at:saved.createdAt},...(next.activity||[])].slice(0,40);
    await saveState(next);await recordAIUsage(completion,'Experiment planning');
    res.json({ok:true,experiment:saved,campaignCreated:true,contentCreated:true,externalActions:0});
  } catch(error){console.error('Experiment planning failed:',error.message);const timedOut=/timeout|timed out/i.test(error.message||'');res.status(timedOut?504:502).json({error:timedOut?'The AI request took too long. Try Build 7-day experiment again; no experiment or campaign was saved.':'Could not build the experiment: '+String(error.message||'Unknown error').slice(0,220)});}
});

app.post('/api/opportunities/analyze', requireAuth, limited('opportunity-analysis', 8, 60 * 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return res.status(503).json({ error: 'AI is not configured. Check OPENAI_API_KEY and OPENAI_MODEL in Render.' });
  const niche = String(req.body?.niche || state.settings.niche || '').trim().slice(0, 160);
  const focus = String(req.body?.focus || '').trim().slice(0, 1200);
  const strategy = String(req.body?.strategy || 'Compare all strategies').slice(0, 100);
  if (!niche) return res.status(400).json({ error: 'Enter a niche or industry first.' });
  try {
    const OpenAI = require('openai'), client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = 'You are a rigorous small-business opportunity analyst. Return only valid JSON. Do not claim to have performed live market research. Do not fabricate search volumes, competitors, prices, demand, conversion rates, affiliate terms or earnings. Treat every score and cost as a hypothesis or estimate that requires validation. Recommend legal, ethical, low-cost tests. Avoid spam and deceptive marketing.';
    const prompt = 'Analyze the niche: ' + niche + '. Strategy preference: ' + strategy + '. User focus: ' + focus + '. Return JSON exactly shaped as {"opportunities":[{"title":"...","customer":"specific target customer","problem":"painful problem","offer":"proposed offer","monetization":"how it could earn revenue","startupCostLow":0,"startupCostHigh":0,"validationDays":7,"timeToFirstSaleDaysLow":7,"timeToFirstSaleDaysHigh":30,"painScore":1,"customerClarityScore":1,"marginPotentialScore":1,"executionEaseScore":1,"validationEaseScore":1,"competitionRiskScore":1,"confidence":"low|medium|high","confidenceReason":"...","unitEconomicsToVerify":["price or commission","variable costs","fulfillment/time cost"],"assumptions":["..."],"validationSteps":["...","...","..."],"mainRisk":"..."}]}. Provide 3 distinct ideas. Cost fields are USD estimates, scores are 1-5 where 5 is favorable except competitionRiskScore where 5 means high risk. Time-to-first-sale is a planning range, not a promise. Do not invent expected sales, revenue, conversion rates, margins, demand, pricing, affiliate terms or earnings. Never present gross margin or monthly profit as known unless actual inputs are provided. No unsupported facts; put uncertain points in assumptions. Each validation plan must be possible without spending money or contacting people without consent.';
    const completion = await client.chat.completions.create({ model: process.env.OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_completion_tokens: 3000 });
    let raw = (completion.choices?.[0]?.message?.content || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.opportunities) || parsed.opportunities.length < 1) throw new Error('No opportunity records returned.');
    const opportunities = parsed.opportunities.slice(0, 5).map((o, index) => {
      const score = key => Math.max(1, Math.min(5, Number(o[key]) || 1));
      const pain=score('painScore'), clarity=score('customerClarityScore'), margin=score('marginPotentialScore'), ease=score('executionEaseScore'), speed=score('validationEaseScore'), risk=score('competitionRiskScore');
      const total = Math.round(((pain*25 + clarity*20 + margin*20 + ease*20 + speed*15) / 5) - ((risk-1)*3));
      return {
        id: Date.now() + index, title: String(o.title || 'Untitled opportunity').slice(0,180),
        customer: String(o.customer || '').slice(0,500), problem: String(o.problem || '').slice(0,700),
        offer: String(o.offer || '').slice(0,700), monetization: String(o.monetization || '').slice(0,500),
        startupCostLow: Math.max(0, Number(o.startupCostLow) || 0), startupCostHigh: Math.max(0, Number(o.startupCostHigh) || 0),
        validationDays: Math.max(1, Math.min(90, Number(o.validationDays) || 14)),
        timeToFirstSaleDaysLow: Math.max(1, Math.min(365, Number(o.timeToFirstSaleDaysLow) || 14)),
        timeToFirstSaleDaysHigh: Math.max(1, Math.min(365, Number(o.timeToFirstSaleDaysHigh) || 45)),
        confidence: ['low','medium','high'].includes(String(o.confidence || '').toLowerCase()) ? String(o.confidence).toLowerCase() : 'low',
        confidenceReason: String(o.confidenceReason || 'Insufficient validated market data; verify before investing.').slice(0,500),
        unitEconomicsToVerify: Array.isArray(o.unitEconomicsToVerify) ? o.unitEconomicsToVerify.slice(0,5).map(x=>String(x).slice(0,300)) : ['Selling price or commission','Variable costs and fees','Fulfillment and time cost'],
        scores: { pain, customerClarity: clarity, marginPotential: margin, executionEase: ease, validationEase: speed, competitionRisk: risk },
        score: Math.max(0, Math.min(100, total)),
        scoreBreakdown: { customerPain: pain, customerClarity: clarity, marginPotential: margin, executionEase: ease, validationEase: speed, competitionRisk: risk },
        assumptions: Array.isArray(o.assumptions) ? o.assumptions.slice(0,6).map(x=>String(x).slice(0,400)) : [],
        validationSteps: Array.isArray(o.validationSteps) ? o.validationSteps.slice(0,5).map(x=>String(x).slice(0,500)) : [],
        mainRisk: String(o.mainRisk || '').slice(0,500),
        status: 'Needs validation', scoreBasis: 'AI-estimated rubric; not verified market data', created: new Date().toISOString()
      };
    }).sort((a,b)=>b.score-a.score);
    const next = structuredClone(state);
    next.opportunities = [...opportunities, ...(next.opportunities || [])].slice(0,500);
    next.activity = [{ message: 'Analyzed and ranked ' + opportunities.length + ' business opportunities', at: new Date().toISOString() }, ...(next.activity || [])].slice(0,40);
    await saveState(next);
    await recordAIUsage(completion, 'Opportunity analysis');
     res.json({ ok: true, opportunities, scoring: 'Weighted planning rubric; all scores and cost ranges are hypotheses pending validation.' });
  } catch (error) {
    console.error('Opportunity analysis failed:', error.message);
    res.status(502).json({ error: 'Opportunity analysis failed. Check Render logs and try again.' });
  }
});


let automationCycleRunning = false;
function buildAutomationSnapshot(source) {
  const now = Date.now();
  const leads = Array.isArray(source.leads) ? source.leads : [];
  const orders = Array.isArray(source.orders) ? source.orders : [];
  const approvals = Array.isArray(source.approvals) ? source.approvals : [];
  const revenue = Array.isArray(source.revenue) ? source.revenue : [];
  const dueLeads = leads.filter(x => x.followUpAt && new Date(x.followUpAt + 'T23:59:59').getTime() <= now && !['Converted','Closed'].includes(x.status));
  const failedDeliveries = orders.filter(x => x.paymentStatus === 'paid' && x.deliveryToken && x.deliveryEmailStatus !== 'sent');
  const pendingApprovals = approvals.filter(x => x.status === 'Pending');
  const unmatchedLeads = leads.filter(x => !x.matchedSupplierId && !['Converted','Closed'].includes(x.status));
  const activeSuppliers = (source.suppliers || []).filter(x => x.status === 'Active');
  const income = revenue.filter(x => x.type === 'Income').reduce((n,x)=>n+Math.max(0,Number(x.amount)||0),0);
  const expenses = revenue.filter(x => x.type === 'Expense').reduce((n,x)=>n+Math.max(0,Number(x.amount)||0),0);
  const tasks = [];
  for (const lead of dueLeads.slice(0,50)) tasks.push({type:'lead_follow_up', title:'Buyer follow-up due: '+(lead.name||'New lead'), detail:'Review the buyer request and prepare a response manually.', recordId:lead.id, action:'manual_review'});
  for (const order of failedDeliveries.slice(0,50)) tasks.push({type:'delivery_attention', title:'Digital delivery needs attention', detail:'Paid order '+String(order.id||'').slice(0,32)+' · inspect delivery status and use the manual retry control if appropriate.', recordId:order.id, action:'manual_review'});
  for (const approval of pendingApprovals.slice(0,50)) tasks.push({type:'approval', title:'Approval waiting: '+(approval.title||'External action'), detail:'Review and decide in the Approval Queue.', recordId:approval.id, action:'approval_required'});
  for (const lead of unmatchedLeads.slice(0,50)) tasks.push({type:'supplier_match', title:'Review supplier match: '+(lead.name||'Buyer lead'), detail:activeSuppliers.length?'Compare active supplier coverage; sharing still requires buyer consent and your approval.':'Add an appropriate supplier before matching this lead.',recordId:lead.id,action:'manual_review'});
  const latestOptimization = (Array.isArray(source.optimizationReports) ? source.optimizationReports : []).slice().sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0))[0];
  const savedOpportunities = Array.isArray(source.opportunities) ? source.opportunities : [];
  const campaigns = Array.isArray(source.campaigns) ? source.campaigns : [];
  const hasCampaignEvidence = campaigns.some(c => Array.isArray(c.metrics) && c.metrics.length);
  if (latestOptimization?.recommendations?.length) {
    for (const recommendation of latestOptimization.recommendations.slice(0,5)) tasks.push({
      type:'revenue_experiment',title:'Revenue action: '+String(recommendation.action||'Review recommendation').slice(0,110),
      detail:String(recommendation.reason||'Review the latest evidence-based optimization recommendation.').slice(0,360)+' Measure: '+String(recommendation.metric||'Record outcome and cost.').slice(0,180),
      recordId:latestOptimization.id,action:'review_recommendation',recommendationPriority:recommendation.priority||'Medium',
      requiresApproval:Boolean(recommendation.requiresApproval),confidence:recommendation.confidence||'Low',effort:recommendation.effort||'Medium'
    });
  } else if (savedOpportunities.length) {
    const candidate=savedOpportunities.slice().sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0))[0];
    tasks.push({type:'revenue_experiment',title:'Validate top opportunity: '+String(candidate.title||'Saved business idea').slice(0,110),
      detail:'Choose one low-cost validation step, record the cost and success threshold, and verify demand before investing. This is a planning hypothesis, not a sales forecast.',
      recordId:candidate.id,action:'validate_opportunity',recommendationPriority:'High',confidence:candidate.confidence||'Low',effort:'Low',requiresApproval:false});
  } else if (String(source.settings?.niche||'').trim()) {
    tasks.push({type:'revenue_experiment',title:'Build a ranked revenue opportunity shortlist',
      detail:'Analyze the configured niche and compare low-cost validation experiments. Estimates must be labeled and validated before spending.',
      action:'generate_opportunity_shortlist',recommendationPriority:'High',confidence:'Low',effort:'Low',requiresApproval:false});
  } else {
    tasks.push({type:'measurement',title:'Set the revenue focus before choosing an experiment',
      detail:'Add a primary niche and monthly revenue goal in Settings so the agent can rank relevant, measurable opportunities.',
      action:'configure_revenue_focus',recommendationPriority:'Medium',confidence:'High',effort:'Low',requiresApproval:false});
  }
  if (!hasCampaignEvidence) tasks.push({type:'measurement',title:'Instrument the next campaign before launch',
    detail:'Record impressions, clicks, leads, conversions, spend and attributed revenue for any test. Do not infer performance from drafts or plans.',
    action:'measure_campaign',recommendationPriority:'Medium',confidence:'High',effort:'Low',requiresApproval:false});
  const priorityRules = {
    delivery_attention:{base:95,impact:'Protects a paid customer order',effort:'Low–medium',risk:'Customer-impacting'},
    approval:{base:75,impact:'Unblocks a pending decision',effort:'Low',risk:'Requires owner decision'},
    lead_follow_up:{base:65,impact:'May recover a qualified buyer opportunity',effort:'Low',risk:'Requires manual review'},
    supplier_match:{base:40,impact:'May improve lead fulfilment potential',effort:'Medium',risk:'Buyer consent required before sharing'},
    revenue_experiment:{base:70,impact:'Advances a measurable revenue experiment',effort:'Low–medium',risk:'Validate assumptions; owner approval for paid or external actions'},
    measurement:{base:50,impact:'Improves evidence quality for revenue decisions',effort:'Low',risk:'No external action'}
  };
  const rankedTasks = tasks.map(task => {
    const rule = priorityRules[task.type] || {base:30,impact:'Needs review',effort:'Unknown',risk:'Review required'};
    const lead = task.type==='lead_follow_up' || task.type==='supplier_match' ? leads.find(x=>String(x.id)===String(task.recordId)) : null;
    const dueTime = lead?.followUpAt ? new Date(lead.followUpAt+'T23:59:59').getTime() : null;
    const overdueDays = Number.isFinite(dueTime) && dueTime!==null ? Math.max(0,Math.floor((now-dueTime)/86400000)) : 0;
    const recommendationBoost = task.recommendationPriority==='High'?10:task.recommendationPriority==='Low'?-10:0;
    const score = Math.min(100,Math.max(0,rule.base + Math.min(20,overdueDays*4) + (lead && Number(lead.score)>=80 ? 5 : 0) + recommendationBoost));
    return {...task,priorityScore:score,priorityBand:score>=85?'Critical':score>=65?'High':score>=45?'Medium':'Low',impact:rule.impact,effort:rule.effort,risk:rule.risk,overdueDays,priorityReason:overdueDays?'Follow-up is '+overdueDays+' day(s) overdue.':rule.impact+'.'};
  }).sort((x,y)=>y.priorityScore-x.priorityScore);
  return {
    generatedAt:new Date().toISOString(),
    modules:{
      opportunities:{status:'ready',items:(source.opportunities||[]).length,detail:'Saved opportunities available for prioritization.'},
      content:{status:'ready',items:(source.content||[]).length,detail:'Draft assets are stored; publishing remains a separate authorized action.'},
      campaigns:{status:'ready',items:(source.campaigns||[]).length,detail:'Campaign plans and entered performance are available for review.'},
      commerce:{status:'ready',items:orders.length,detail:failedDeliveries.length+' paid digital orders need delivery review.'},
      buyerLeads:{status:dueLeads.length?'attention':'ready',items:leads.length,due:dueLeads.length,detail:dueLeads.length+' follow-ups due or overdue.'},
      suppliers:{status:unmatchedLeads.length?'attention':'ready',items:activeSuppliers.length,unmatched:unmatchedLeads.length,detail:'Supplier matching is advisory; external sharing is never automatic.'},
      revenue:{status:'ready',income:Number(income.toFixed(2)),expenses:Number(expenses.toFixed(2)),net:Number((income-expenses).toFixed(2)),detail:'Totals use saved ledger entries only; projections are excluded.'},
      optimization:{status:'ready',items:(source.optimizationReports||[]).length,detail:'Optimization reports remain advisory and rely on recorded data.'},
      approvals:{status:pendingApprovals.length?'attention':'ready',items:pendingApprovals.length,detail:pendingApprovals.length+' decisions waiting.'}
    },
    tasks:rankedTasks.slice(0,100),
    counts:{tasks:tasks.length,dueLeads:dueLeads.length,failedDeliveries:failedDeliveries.length,pendingApprovals:pendingApprovals.length,unmatchedLeads:unmatchedLeads.length}
  };
}
app.get('/api/automation/status', requireAuth, async (req,res) => {
  const snapshot=buildAutomationSnapshot(state);
  const latest=(state.automationRuns||[]).find(x=>x.kind==='full_cycle');
  res.json({ok:true,scheduledExecution:false,lastRun:latest||null,...snapshot});
});
app.post('/api/automation/run-cycle', requireAuth, limited('automation-cycle', 6, 60*60*1000), async (req,res) => {
  if (automationCycleRunning) return res.status(409).json({error:'An automation cycle is already running. Refresh the status in a moment.'});
  automationCycleRunning=true;
  try {
    const snapshot=buildAutomationSnapshot(state);
    const now=new Date().toISOString();
    const run={id:crypto.randomUUID(),kind:'full_cycle',status:'Completed · review tasks generated',created:now,counts:snapshot.counts,modules:Object.keys(snapshot.modules),scheduledExecution:false};
    const next=structuredClone(state);
    next.automationRuns=[run,...(next.automationRuns||[])].slice(0,50);
    next.activity=[{message:'Full-app automation cycle reviewed all modules and generated '+snapshot.counts.tasks+' internal action items',at:now},...(next.activity||[])].slice(0,40);
    await saveState(next);
    res.json({ok:true,run,snapshot,safety:{externalMessagesSent:0,paidActions:0,customerDataShared:0,contentPublished:0}});
  } catch(error) {
    console.error('Full automation cycle failed:',error.message);
    res.status(500).json({error:'Automation cycle failed. Check the test service logs.'});
  } finally { automationCycleRunning=false; }
});

app.post('/api/automation/run', requireAuth, limited('automation', 5, 60 * 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
    return res.status(503).json({ error: 'AI is not configured. Check OPENAI_API_KEY and OPENAI_MODEL in Render.' });
  }
  try {
    const niche = String(req.body?.niche || state.settings.niche || '').slice(0, 160);
    const strategies = Array.isArray(req.body?.strategies) ? req.body.strategies.slice(0, 8) : state.settings.strategies;
    if (!niche.trim()) return res.status(400).json({ error: 'Set a primary niche in Settings before running automation.' });
    const OpenAI = require('openai'), client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = 'You are the planning engine for AutoRevenue AI. Return only valid JSON. Create realistic, lawful, low-cost business experiments. Do not invent market research, prices, audience sizes, affiliate terms, or performance data. Label assumptions and estimates. Do not propose spam, deceptive claims, or unauthorized use of personal data. Never claim to publish, spend, contact customers, or execute external actions.';
    const prompt = 'Build one coordinated starter plan for niche: ' + niche + '. Allowed strategies: ' + strategies.join(', ') + '. Return JSON with exactly these keys: opportunityTitle (string), opportunityDescription (string), validationSteps (array of 3 strings), campaignName (string), campaignChannel (string), campaignGoal (string), campaignDuration (string), campaignPlan (string), contentTitle (string), contentType (string), contentDraft (string), nextStep (string). Include a 7- or 14-day measurable test, low-cost assumptions, and a clear ethical call to action. This is a draft plan only; no external actions.';
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_completion_tokens: 2400
    });
    let raw = completion.choices?.[0]?.message?.content?.trim() || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const plan = JSON.parse(raw);
    const required = ['opportunityTitle','opportunityDescription','campaignName','campaignPlan','contentTitle','contentDraft','nextStep'];
    if (required.some(key => typeof plan[key] !== 'string' || !plan[key].trim())) throw new Error('The planning engine returned incomplete JSON.');
    const now = new Date().toISOString(), id = Date.now();
    const opportunity = { id, title: plan.opportunityTitle, body: plan.opportunityDescription + '\\n\\nValidation steps:\\n' + (Array.isArray(plan.validationSteps) ? plan.validationSteps.map((x, i) => (i + 1) + '. ' + x).join('\\n') : ''), status: 'Needs validation', created: now };
    const campaign = { id: id + 1, name: plan.campaignName, channel: plan.campaignChannel || 'Website / blog', goal: plan.campaignGoal || 'Validate demand', duration: plan.campaignDuration || '14 days', plan: plan.campaignPlan, status: 'Draft · not published', created: now };
    const content = { id: id + 2, title: plan.contentTitle, type: plan.contentType || 'Marketing draft', body: plan.contentDraft, status: 'Draft · not published', created: now };
    const next = structuredClone(state);
    next.opportunities.unshift(opportunity);
    next.campaigns.unshift(campaign);
    next.content.unshift(content);
    // Creating internal drafts is non-billable and does not publish or contact anyone.
    // Reserve the approval queue for external actions that require explicit authorization.
    next.automationRuns = Array.isArray(next.automationRuns) ? next.automationRuns : [];
    next.automationRuns.unshift({ id, niche, status: 'Completed · drafts created', nextStep: plan.nextStep, created: now });
    next.automationRuns = next.automationRuns.slice(0, 50);
    next.activity = [{ message: 'Automation run created an opportunity, campaign and content draft for review', at: now }, ...(next.activity || [])].slice(0, 40);
    await saveState(next);
    await recordAIUsage(completion, 'Automation cycle');
     res.json({ ok: true, created: { opportunity: opportunity.title, campaign: campaign.name, content: content.title }, approvalsRequired: 0, nextStep: plan.nextStep });
  } catch (error) {
    console.error('Automation run failed:', error.message);
    res.status(502).json({ error: 'Automation could not complete this run. Check Render logs and try again.' });
  }
});


app.post('/api/optimization/analyze', requireAuth, limited('optimization', 3, 60 * 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
    return res.status(503).json({ error: 'AI is not configured. Check OPENAI_API_KEY and OPENAI_MODEL in Render.' });
  }
  try {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const allLedgerEntries = (state.revenue || []).filter(x => Number.isFinite(Number(x.amount)) && Number(x.amount) >= 0);
    // Stripe webhook sales are represented in the Stripe balance feed; exclude them from the manual ledger totals to prevent double-counting.
    const stripeLedgerEntriesExcluded = allLedgerEntries.filter(x => Boolean(x.checkoutSessionId) || /^Stripe sale:/i.test(String(x.source || ''))).length;
    const ledger = allLedgerEntries.filter(x => !x.checkoutSessionId && !/^Stripe sale:/i.test(String(x.source || '')));
    const sum = (rows, type) => rows.filter(x => x.type === type).reduce((n, x) => n + Number(x.amount || 0), 0);
    const recentLedger = ledger.filter(x => {
      const date = Date.parse(String(x.date || '') + 'T00:00:00Z');
      return Number.isFinite(date) && date >= cutoff;
    });
    const campaigns = (state.campaigns || []).slice(0, 30).map(c => {
      const metrics = Array.isArray(c.metrics) ? c.metrics : [];
      const totals = key => metrics.reduce((n, m) => n + Math.max(0, Number(m[key]) || 0), 0);
      const impressions = totals('impressions'), clicks = totals('clicks'), leads = totals('leads');
      const conversions = totals('conversions'), spend = totals('spend'), revenue = totals('revenue');
      return {
        name: String(c.name || '').slice(0, 120), channel: String(c.channel || '').slice(0, 80),
        snapshots: metrics.length, impressions, clicks, leads, conversions, spend, attributedRevenue: revenue,
        attributedNet: revenue - spend,
        ctrPercent: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null,
        conversionPercent: clicks ? Number((conversions / clicks * 100).toFixed(2)) : null
      };
    });
    const snapshot = {
      niche: String(state.settings?.niche || '').slice(0, 160),
      monthlyGoal: Number(state.settings?.monthlyGoal || 0),
      allTimeLedger: { income: sum(ledger, 'Income'), expenses: sum(ledger, 'Expense'), net: sum(ledger, 'Income') - sum(ledger, 'Expense'), entries: ledger.length },
      last30DaysLedger: { income: sum(recentLedger, 'Income'), expenses: sum(recentLedger, 'Expense'), net: sum(recentLedger, 'Income') - sum(recentLedger, 'Expense'), entries: recentLedger.length },
      campaignPerformance: campaigns,
      opportunities: (state.opportunities || []).slice(0, 12).map(o => ({
        title: String(o.title || '').slice(0, 140), score: Number(o.score) || null,
        status: String(o.status || '').slice(0, 60), validationDays: Number(o.validationDays) || null
      })),
      contentAssets: (state.content || []).length,
      automationRuns: (state.automationRuns || []).length,
      products: (state.products || []).filter(p => p.active).length,
      paidOrders: (state.orders || []).filter(o => o.paymentStatus === 'paid').length,
      stripeTransactions: (() => null)()
    };
    const stripeSnapshot = await getStripeTransactionSnapshot(getStripeClient());
    snapshot.stripeTransactions = {
      mode: stripeSnapshot.mode,
      availableBalance: stripeSnapshot.balance.available,
      pendingBalance: stripeSnapshot.balance.pending,
      transactionCount: stripeSnapshot.transactions.length,
      grossCharges: Number(stripeSnapshot.transactions.filter(t => ['charge', 'payment'].includes(t.type) && t.amount > 0).reduce((n,t)=>n+t.amount,0).toFixed(2)),
      stripeLedgerEntriesExcluded,
      refunds: Number(Math.abs(stripeSnapshot.transactions.filter(t => t.type === 'refund').reduce((n,t)=>n+t.amount,0)).toFixed(2)),
      fees: Number(stripeSnapshot.transactions.reduce((n,t)=>n+t.fee,0).toFixed(2)),
      netBalanceActivity: Number(stripeSnapshot.transactions.reduce((n,t)=>n+t.net,0).toFixed(2)),
      payouts: stripeSnapshot.payouts.slice(0, 50)
    };
    const OpenAI = require('openai'), client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 0 });
    const system = 'You are the revenue optimization analyst for a small business. Return only valid JSON. Analyze only the supplied workspace data. Never invent performance, market demand, conversion rates, revenue, costs, customer counts, or causes. Clearly distinguish observed facts from hypotheses. Campaign-attributed revenue is not necessarily collected cash; do not add it to the ledger. Stripe webhook-generated ledger entries are excluded from manual ledger totals to prevent double-counting; analyze Stripe totals separately. Do not recommend ad spend, purchases, subscriptions, or paid services without explicitly marking them as requiring owner approval. Prioritize low-cost, measurable actions. If data is sparse, say so and recommend what to measure before drawing conclusions.';
    const prompt = 'Analyze this AutoRevenue AI workspace snapshot and return JSON exactly shaped as {"executiveSummary":"...","dataGaps":["..."],"recommendations":[{"priority":"High|Medium|Low","action":"specific action","reason":"evidence from supplied data or clearly labeled hypothesis","metric":"what to measure","effort":"Low|Medium|High","confidence":"High|Medium|Low","requiresApproval":false}]}. Give 3 to 5 ranked recommendations. Include at least one measurement/data-quality action when evidence is limited. Do not suggest that any action has already been taken. Snapshot: ' + JSON.stringify(snapshot);
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_completion_tokens: 2200
    });
    let raw = (completion.choices?.[0]?.message?.content || '').trim().replace(/^`{3}(?:json)?s*/i, '').replace(/s*`{3}$/, '');
    const report = JSON.parse(raw);
    if (typeof report.executiveSummary !== 'string' || !Array.isArray(report.recommendations)) throw new Error('The optimization engine returned an invalid report.');
    report.executiveSummary = report.executiveSummary.slice(0, 1600);
    report.dataGaps = Array.isArray(report.dataGaps) ? report.dataGaps.slice(0, 8).map(x => String(x).slice(0, 400)) : [];
    report.recommendations = report.recommendations.slice(0, 5).map(r => ({
      priority: ['High', 'Medium', 'Low'].includes(r.priority) ? r.priority : 'Medium',
      action: String(r.action || '').slice(0, 500),
      reason: String(r.reason || '').slice(0, 700),
      metric: String(r.metric || '').slice(0, 300),
      effort: ['Low', 'Medium', 'High'].includes(r.effort) ? r.effort : 'Medium',
      confidence: ['High', 'Medium', 'Low'].includes(r.confidence) ? r.confidence : 'Low',
      requiresApproval: Boolean(r.requiresApproval)
    })).filter(r => r.action && r.reason);
    if (!report.recommendations.length) throw new Error('The optimization engine returned no usable recommendations.');
    const saved = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), summary: report.executiveSummary, recommendations: report.recommendations, dataGaps: report.dataGaps };
    const next = structuredClone(state);
    next.optimizationReports = Array.isArray(next.optimizationReports) ? next.optimizationReports : [];
    next.optimizationReports.unshift(saved);
    next.optimizationReports = next.optimizationReports.slice(0, 25);
    next.activity = [{ message: 'Generated a revenue optimization report', at: saved.createdAt }, ...(next.activity || [])].slice(0, 40);
    await saveState(next);
    await recordAIUsage(completion, 'Revenue optimization');
    res.json({ ok: true, report: saved, snapshotSummary: { ledgerEntries: ledger.length, campaignCount: campaigns.length, opportunityCount: (state.opportunities || []).length } });
  } catch (error) {
    console.error('Revenue optimization failed:', error.message);
    res.status(502).json({ error: 'Revenue optimization failed. Check Render logs and try again.' });
  }
});

app.get('*', (req, res) => {
  const file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file)) return res.status(500).send('Missing public/index.html');
  res.sendFile(file);
});
initStorage().then(() => app.listen(PORT, () => console.log('AutoRevenue AI 2.0 listening on port ' + PORT)))
  .catch(error => { console.error('Startup failed:', error); process.exit(1); });
