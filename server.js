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
  opportunities: [], campaigns: [], content: [], revenue: [], approvals: [], automationRuns: [], aiUsage: [], optimizationReports: [], golfOpportunities: [], products: [], orders: [], subscriptions: [],
  settings: { niche: '', monthlyGoal: 500, autonomy: 'approval', strategies: ['affiliate', 'digital-products', 'lead-generation', 'content'] },
  activity: []
};
app.disable('x-powered-by');
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
const STATE_LISTS = ['opportunities', 'campaigns', 'content', 'revenue', 'approvals', 'automationRuns', 'aiUsage', 'optimizationReports', 'golfOpportunities', 'products', 'orders', 'subscriptions', 'activity'];
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
    const result = await pool.query('SELECT payload FROM autorevenue_ai_state WHERE id = 1');
    if (result.rows[0]) state = cleanState(result.rows[0].payload);
    else await pool.query('INSERT INTO autorevenue_ai_state (id, payload) VALUES (1, $1)', [state]);
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
      createdAt: new Date().toISOString()
    });
    next.aiUsage = next.aiUsage.slice(0, 500);
    await saveState(next);
  } catch (error) {
    console.error('AI usage tracking failed:', error.message);
  }
}
function clientIp(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'; }
function limited(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + clientIp(req), now = Date.now();
    requestCount++;
    if (requestCount % 100 === 0) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    const entry = attempts.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++; attempts.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    next();
  };
}
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expires = sessions.get(token);
  if (!token || !expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Please sign in again.' });
  }
  req.sessionToken = token; next();
}
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'AutoRevenue AI', version: '2.0.0',
  authConfigured: Boolean(process.env.ADMIN_PASSWORD),
  stripeTestConfigured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')),
  stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  emailDeliveryConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
  aiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
  persistentStorage: Boolean(process.env.DATABASE_URL), storageMode: pool ? 'postgres' : 'local-json', storageReady
}));
app.post('/api/login', limited('login', 10, 15 * 60 * 1000), (req, res) => {
  const password = String(req.body?.password || '');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin sign-in is not configured. Add ADMIN_PASSWORD in Render environment variables.' });
  const expected = Buffer.from(process.env.ADMIN_PASSWORD), supplied = Buffer.from(password);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ token: createSession() });
});
app.post('/api/logout', requireAuth, (req, res) => { sessions.delete(req.sessionToken); res.json({ ok: true }); });

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
      paymentStatus: charge?.status || '',
      refunded: charge ? charge.amount_refunded / 100 : null
    };
  });
  return {
    mode: 'test',
    currency: 'USD',
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


app.post('/api/opportunities/analyze', requireAuth, limited('opportunity-analysis', 8, 60 * 60 * 1000), async (req, res) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return res.status(503).json({ error: 'AI is not configured. Check OPENAI_API_KEY and OPENAI_MODEL in Render.' });
  const niche = String(req.body?.niche || state.settings.niche || '').trim().slice(0, 160);
  const focus = String(req.body?.focus || '').trim().slice(0, 1200);
  const strategy = String(req.body?.strategy || 'Compare all strategies').slice(0, 100);
  if (!niche) return res.status(400).json({ error: 'Enter a niche or industry first.' });
  try {
    const OpenAI = require('openai'), client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = 'You are a rigorous small-business opportunity analyst. Return only valid JSON. Do not claim to have performed live market research. Do not fabricate search volumes, competitors, prices, demand, conversion rates, affiliate terms or earnings. Treat every score and cost as a hypothesis or estimate that requires validation. Recommend legal, ethical, low-cost tests. Avoid spam and deceptive marketing.';
    const prompt = 'Analyze the niche: ' + niche + '. Strategy preference: ' + strategy + '. User focus: ' + focus + '. Return JSON exactly shaped as {"opportunities":[{"title":"...","customer":"specific target customer","problem":"painful problem","offer":"proposed offer","monetization":"how it could earn revenue","startupCostLow":0,"startupCostHigh":0,"validationDays":7,"painScore":1,"customerClarityScore":1,"marginPotentialScore":1,"executionEaseScore":1,"validationEaseScore":1,"competitionRiskScore":1,"assumptions":["..."],"validationSteps":["...","...","..."],"mainRisk":"..."}]}. Provide 3 distinct ideas. Cost fields are USD estimates, scores are 1-5 where 5 is favorable except competitionRiskScore where 5 means high risk. No unsupported facts; put uncertain points in assumptions. Each validation plan must be possible without spending money or contacting people without consent.';
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
        scores: { pain, customerClarity: clarity, marginPotential: margin, executionEase: ease, validationEase: speed, competitionRisk: risk },
        score: Math.max(0, Math.min(100, total)),
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
