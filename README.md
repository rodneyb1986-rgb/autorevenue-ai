# AutoRevenue AI — Fresh Build 1.0

A clean, revenue-focused content operations dashboard. This first build includes persistent JSON data, AI content generation (when configured), campaigns, opportunity tracking, an approval queue, settings, and manual analytics event tracking.

## Run locally

1. Install Node.js 20+
2. Copy `.env.example` to `.env`
3. Optionally add `OPENAI_API_KEY` and `OPENAI_MODEL`
4. Run `npm install`
5. Run `npm start`
6. Open `http://localhost:3000`

Without an API key, the content generator uses a clearly basic local draft template so the app remains testable.

## Render deployment

- Build command: `npm install`
- Start command: `npm start`
- Environment: `OPENAI_API_KEY` (optional), `OPENAI_MODEL` (optional), `PORT` (Render supplies this)

For persistent data on Render, attach a persistent disk and mount it at `/opt/render/project/src/data`, or move storage to a managed database before production use.

## API

- `GET /api/health`
- `GET /api/dashboard`
- `GET/POST /api/opportunities`
- `GET/POST /api/campaigns`
- `GET/POST /api/posts`
- `POST /api/generate`
- `PATCH/DELETE /api/posts/:id`
- `GET/PUT /api/settings`
- `POST /api/analytics/event`

## Not yet connected

No live social publishing, Meta OAuth, affiliate networks, link tracking, or real analytics ingestion is included. Publishing is intentionally not automated in this build. Generated posts enter the approval queue.
