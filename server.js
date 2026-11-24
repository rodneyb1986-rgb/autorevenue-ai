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
const DEFAULT_STATE = {
  opportunities: [], campaigns: [], content: [], revenue: [], approvals: [],
  settings: { niche: '', monthlyGoal: 500, autonomy: 'approval', strategies: ['affiliate', 'digital-products', 'lead-generation', 'content'] },
  activity: []
};
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC, { index: false }));

let pool = null;
let state = structuredClone(DEFAULT_STATE);
function cleanState(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = { ...structuredClone(DEFAULT_STATE), ...v };
  for (const key of ['opportunities', 'campaigns', 'content', 'revenue', 'approvals', 'activity']) {
    if (!Array.isArray(out[key])) out[key] = [];
    out[key] = out[key].slice(-500);
  }
  out.settings = { ...DEFAULT_STATE.settings, ...(out.settings || {}) };
  return out;
}
async function initStorage() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000 });
    await pool.query('CREATE TABLE IF NOT EXISTS autorevenue_state (id integer PRIMARY KEY CHECK (id = 1), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const result = await pool.query('SELECT payload FROM autorevenue_state WHERE id = 1');
    if (result.rows[0]) state = cleanState(result.rows[0].payload);
    else await pool.query('INSERT INTO autorevenue_state (id, payload) VALUES (1, $1)', [state]);
    console.log('Persistent PostgreSQL storage connected.');
  } else {
    try { state = cleanState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch { state = structuredClone(DEFAULT_STATE); }
    console.warn('DATABASE_URL is not configured: using local JSON storage. Data may not survive a Render restart or redeploy.');
  }
}
async function saveState(next) {
  state = cleanState(next);
  if (pool) await pool.query('INSERT INTO autorevenue_state (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()', [state]);
  else { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
}
function clientIp(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'; }
function limited(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + clientIp(req), now = Date.now();
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
  persistentStorage: Boolean(process.env.DATABASE_URL)
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
      temperature: 0.7, max_tokens: 1800
    });
    const result = completion.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error('The model returned an empty response.');
    res.json({ result, model: process.env.OPENAI_MODEL });
  } catch (error) {
    console.error('AI generation failed:', error.message);
    res.status(502).json({ error: 'AI generation failed. Check OPENAI_MODEL, API project access, and Render logs.' });
  }
});
app.get('*', (req, res) => {
  const file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file)) return res.status(500).send('Missing public/index.html');
  res.sendFile(file);
});
initStorage().then(() => app.listen(PORT, () => console.log('AutoRevenue AI 2.0 listening on port ' + PORT)))
  .catch(error => { console.error('Startup failed:', error); process.exit(1); });
