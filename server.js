require('dotenv').config();
const express = require('express');
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
  opportunities: [], campaigns: [], content: [], revenue: [], approvals: [], automationRuns: [],
  settings: { niche: '', monthlyGoal: 500, autonomy: 'approval', strategies: ['affiliate', 'digital-products', 'lead-generation', 'content'] },
  activity: []
};
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC, { index: false }));

let pool = null;
let state = structuredClone(DEFAULT_STATE);
const STATE_LISTS = ['opportunities', 'campaigns', 'content', 'revenue', 'approvals', 'automationRuns', 'activity'];
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
