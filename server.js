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
  opportunities: [], campaigns: [], content: [], revenue: [], approvals: [], automationRuns: [], golfOpportunities: [], products: [], orders: [], subscriptions: [],
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
        status: 'paid', updatedAt: now, createdAt: existing?.createdAt || now
      };
      if (existing) Object.assign(existing, order); else next.orders.unshift(order);
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
const STATE_LISTS = ['opportunities', 'campaigns', 'content', 'revenue', 'approvals', 'automationRuns', 'golfOpportunities', 'products', 'orders', 'subscriptions', 'activity'];
const ALLOWED_STRATEGIES = ['affiliate', 'digital-products', 'lead-generation', 'content', 'services'];
function cleanState(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...structuredClone(DEFAULT_STATE), ...v };
  for (const key of STATE_LISTS) {
    const rows = Array.isArray(out[key]) ? out[key].slice(-500) : [];
    out[key] = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
      .map(row => Object.fromEntries(Object.entries(row).filter(([, val]) =>
        val === null || ['string', 'number', 'boolean'].includes(typeof val) ||
        (Array.isArray(val) && val.length <= 100)
      )));
  }
  const settings = out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings) ? out.settings : {};
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
  aiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
  persistentStorage: Boolean(process.env.DATABASE_URL), storageReady
}));
app.post('/api/login', limited('login', 10, 15 * 60 * 1000), (req, res) => {
  const password = String(req.body?.password || '');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin sign-in is not configured. Add ADMIN_PASSWORD in Render environment variables.' });
  const expected = Buffer.from(process.env.ADMIN_PASSWORD), supplied = Buffer.from(password);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ token: createSession() });
});
app.post('/api/logout', requireAuth, (req, res) => { sessions.delete(req.sessionToken); res.json({ ok: true }); });

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured. Add STRIPE_SECRET_KEY in Render.');
  if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Only Stripe test-mode keys are accepted by this build.');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
app.get('/api/commerce/products', requireAuth, (req, res) => res.json({ products: state.products || [] }));
app.post('/api/commerce/products', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 160);
    const description = String(body.description || '').trim().slice(0, 2000);
    const type = body.type === 'physical' ? 'physical' : 'digital';
    const billing = body.billing === 'subscription' ? 'subscription' : 'one_time';
    const amount = Number(body.amount);
    const interval = ['month', 'year'].includes(body.interval) ? body.interval : 'month';
    if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter a product name and a valid positive price.' });
    if (billing === 'subscription' && type === 'physical') return res.status(400).json({ error: 'Recurring physical-product orders are not enabled yet. Use one-time checkout for shipped goods.' });
    const product = { id: crypto.randomUUID(), name, description, type, billing, amount: Math.round(amount * 100) / 100, currency: 'usd', interval: billing === 'subscription' ? interval : null, active: true, createdAt: new Date().toISOString() };
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
app.get('/api/state', requireAuth, (req, res) => res.json(state));
app.put('/api/state', requireAuth, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid workspace data.' });
    await saveState(req.body); res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (error) { console.error('State save failed:', error.message); res.status(500).json({ error: 'Could not save workspace data.' }); }
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
    const campaign = { id: id + 1, name: plan.campaignName, channel: plan.campaignChannel || 'Website / blog', goal: plan.campaignGoal || 'Validate demand', duration: plan.campaignDuration || '14 days', plan: plan.campaignPlan, status: 'Draft · approval required', created: now };
    const content = { id: id + 2, title: plan.contentTitle, type: plan.contentType || 'Marketing draft', body: plan.contentDraft, status: 'Draft · approval required', created: now };
    const next = structuredClone(state);
    next.opportunities.unshift(opportunity);
    next.campaigns.unshift(campaign);
    next.content.unshift(content);
    next.approvals.unshift(
      { id: id + 3, title: 'Review campaign: ' + campaign.name, details: campaign.plan, status: 'Pending', created: now },
      { id: id + 4, title: 'Review content: ' + content.title, details: content.body, status: 'Pending', created: now }
    );
    next.automationRuns = Array.isArray(next.automationRuns) ? next.automationRuns : [];
    next.automationRuns.unshift({ id, niche, status: 'Completed · drafts created', nextStep: plan.nextStep, created: now });
    next.automationRuns = next.automationRuns.slice(0, 50);
    next.activity = [{ message: 'Automation run created an opportunity, campaign and content draft for review', at: now }, ...(next.activity || [])].slice(0, 40);
    await saveState(next);
    res.json({ ok: true, created: { opportunity: opportunity.title, campaign: campaign.name, content: content.title }, approvalsRequired: 2, nextStep: plan.nextStep });
  } catch (error) {
    console.error('Automation run failed:', error.message);
    res.status(502).json({ error: 'Automation could not complete this run. Check Render logs and try again.' });
  }
});

app.get('*', (req, res) => {
  const file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file)) return res.status(500).send('Missing public/index.html');
  res.sendFile(file);
});
initStorage().then(() => app.listen(PORT, () => console.log('AutoRevenue AI 2.0 listening on port ' + PORT)))
  .catch(error => { console.error('Startup failed:', error); process.exit(1); });
