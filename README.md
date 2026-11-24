# AutoRevenue AI 2.0

Approval-first revenue operations workspace. This branch is an isolated test build; it does not change main.

## Deploy to a separate Render test service

- Build command: npm install
- Start command: npm start
- Runtime: Node.js 20+

## Required Render environment variables

- ADMIN_PASSWORD: private dashboard sign-in password.
- OPENAI_API_KEY: API key for the OpenAI project.
- OPENAI_MODEL: exact model ID enabled for that API project. Do not guess this value.
- DATABASE_URL: recommended PostgreSQL connection string for durable workspace data.
- PGSSLMODE: optional; set to disable only for a database that explicitly does not use TLS.

The app reports missing configuration in its health endpoint without exposing secrets. If DATABASE_URL is absent, it falls back to local JSON storage, which is not durable across all Render deploy/restart configurations.

## Current capabilities

- Private sign-in with expiring in-memory sessions.
- Protected workspace state and AI generation endpoints.
- Rate-limited sign-in and AI generation.
- Opportunity, content, campaign, approval, and revenue workspaces.
- PostgreSQL persistence when DATABASE_URL is configured.
- AI generation is advisory: it does not publish, buy, message, or execute external actions.

## Approval model

External integrations and actual posting/affiliate transactions are not enabled in this build. Campaigns and approvals are tracked in the workspace until those integrations are separately configured and explicitly authorized.
