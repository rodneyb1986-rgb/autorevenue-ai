# AutoRevenue AI 2.0 — Agent Operating Model

## Purpose

Move AutoRevenue from separate AI tools toward an approval-first revenue operations agent. The agent should observe the workspace, identify the highest-value next task, prepare work, check outcomes, and recommend the next action. This document describes the intended model; it does not claim scheduled autonomous execution or external integrations are already implemented.

## Core agent loop

1. **Observe** — read permitted workspace data: opportunities, campaigns, content, buyer leads, suppliers, golf partnerships, orders, delivery status, approvals, and recorded revenue/expenses.
2. **Interpret** — identify bottlenecks, deadlines, incomplete records, failed workflows, and evidence-supported opportunities.
3. **Prioritize** — rank tasks by expected value, confidence, effort, urgency, risk, and dependencies.
4. **Plan** — create a measurable plan with owner, due date, prerequisites, success metric, cost estimate, confidence, and stop condition.
5. **Prepare** — create internal drafts, task records, research briefs, campaign plans, and follow-up drafts.
6. **Request approval** — queue actions affecting an external system, customer, public content, money, personal data, or reputation.
7. **Execute within permission** — only perform actions covered by explicit user-granted permissions and the approved task.
8. **Verify** — confirm the result at the authoritative destination, not merely that a request was sent.
9. **Learn** — compare actual outcomes with the plan, record results, and adjust priorities.

## Autonomy levels

- **Draft mode:** observe, analyze, and prepare drafts. No external actions.
- **Approval mode (default):** internal, reversible workspace operations are allowed; all external actions require explicit approval.
- **Restricted automatic mode (future, opt-in):** only narrow, pre-authorized, reversible tasks with limits, logs, and a kill switch. No spending, public publishing, customer messaging, personal-data sharing, account changes, or legal/financial commitments.

The current settings normalize autonomy to draft or approval. Do not present restricted automatic mode as available until implemented and tested.

## Agent command center

The primary interface should answer: What did the agent inspect? What changed? What is the best next action and why? What is waiting for approval? What failed? What outcome should be verified? When did the agent last run and what data did it use?

Recommended panels:

1. **Agent status:** idle/running/needs approval/error; last run; next scheduled run only if scheduling is active.
2. **Today's priority:** one recommended next task with evidence, effort, confidence, and start/reject/defer choices.
3. **Work queue:** ready, blocked, waiting for approval, completed.
4. **Approval inbox:** exact action, destination, content/data involved, cost, and consequences.
5. **Run history:** observations, decisions, drafts, execution outcomes, errors, and verification evidence.
6. **Business pulse:** actual recorded income, expenses, net, paid orders, qualified leads, overdue follow-ups, and partnership pipeline. Projections must be separated from actuals.

## Task record

Each task should include a stable ID and idempotency key; timestamps; source records and evidence; task type and priority; rationale and confidence; estimated cost and effort (or explicitly unknown); prerequisites and blockers; proposed action and exact target; approval state and approver timestamp; execution state and external reference; verification state and evidence; result metric, actual outcome, and learning note.

## Permission and safety model

Always require explicit approval before sending email, SMS, or direct messages; publishing public content; creating or changing paid advertising; spending money or buying inventory; issuing refunds or changing payment/customer records; sharing personal data; accepting partnership terms or making claims on the user's behalf; changing production services, secrets, DNS, or live payment configuration.

Approval must be scoped to one exact action, destination, payload, and cost ceiling. It cannot be reused for materially different content or recipients. Changed or expired actions return to pending approval.

Provide a global pause/kill switch. Log every run and action. Use rate limits, retries with backoff, idempotency keys, and maximum run budgets. Never expose credentials to the model or browser.

## Evidence and financial integrity

- Actuals come from saved ledger entries and verified payment-provider events.
- Forecasts and AI estimates are separate and labelled as estimates.
- Never fabricate demand, audience size, affiliate terms, conversion rates, margins, customer results, or earnings.
- A successful HTTP request is not proof that an email was delivered, a post was published, or a payment was received.
- Verify external actions at their authoritative destination.
- Keep test transactions separate from real revenue.

## Initial implementation phases

### Phase 1 — Agent command center
Agent status and last-run summary; unified prioritized task queue; evidence-backed recommendation cards; approval inbox and run history; manual Run Agent Now control. No scheduled runs and no external execution.

### Phase 2 — Planning and internal work
Convert the best recommendation into a structured plan; create internal content/campaign/follow-up drafts; track status, due dates, dependencies, outcomes; add idempotency and duplicate prevention.

### Phase 3 — Scheduled observation
Add a scheduler only after explicit configuration. Run read-only observation on a user-selected cadence and notify the user of priorities and blockers. No external action without approval.

### Phase 4 — Approved integrations
Add one external integration at a time. Show exact action and destination in the approval request. Execute only after approval; verify and log evidence. Add per-integration limits and emergency pause.

## Acceptance criteria

A phase is complete only when it demonstrates traceable inputs and evidence; structured task and decision records; server-enforced permissions; idempotent execution and failure handling; independent outcome verification; visible audit trail; working pause mechanism; and no production changes unless separately approved.

## Current baseline

The current test-branch code includes AI opportunity analysis, a growth-plan run that creates opportunity/campaign/content drafts, a full-app review cycle that creates internal action items, a pending approval list, and a dashboard. The full-cycle endpoint reports scheduledExecution false and performs an internal review; it does not run a background schedule or autonomously execute external actions. This is the baseline to build from, not something to overstate.
