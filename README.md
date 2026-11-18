# AutoRevenue AI

## Render deployment
Build Command: `npm install`
Start Command: `npm start`
Runtime: Node.js

Keep `server.js`, `package.json`, and the `public/` folder at the repository root.

Optional AI: Add `OPENAI_API_KEY` and `OPENAI_MODEL` in Render Environment Variables. Never commit API keys.

API endpoints: `GET /api/health`, `GET /api/data`, `POST /api/data`, `POST /api/generate`.
