'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentPlan } = require('../lib/agent-plan');

function validPlan(overrides = {}) {
  return {
    operation: 'review_workspace_evidence',
    objective: 'Validate a customer problem using existing information.',
    assumptions: ['The problem is important to the target customer.'],
    steps: [1,2,3].map(n => ({
      step: 'Step ' + n,
      ownerAction: 'Review existing evidence',
      successCheck: 'Record one verifiable finding',
      approvalRequired: false
    })),
    successMetric: 'Three evidence-backed findings',
    target: 'Complete review in one week',
    budgetCapUsd: 0,
    timeboxDays: 7,
    risks: ['Evidence may be incomplete'],
    nextAction: 'Review the first finding',
    ...overrides
  };
}

test('validates and normalizes a zero-spend plan', () => {
  const result = validateAgentPlan(validPlan());
  assert.equal(result.budgetCapUsd, 0);
  assert.equal(result.steps.length, 3);
  assert.equal(result.timeboxDays, 7);
});

test('rejects non-zero budgets until spending authority exists', () => {
  assert.throws(() => validateAgentPlan(validPlan({ budgetCapUsd: 1 })), /zero-dollar budget/);
});

test('rejects missing approval declaration on any step', () => {
  const p = validPlan();
  delete p.steps[1].approvalRequired;
  assert.throws(() => validateAgentPlan(p), /approvalRequired/);
});

test('rejects too few or too many steps', () => {
  assert.throws(() => validateAgentPlan(validPlan({ steps: [] })), /3 to 6/);
  assert.throws(() => validateAgentPlan(validPlan({ steps: Array.from({length:7},(_,i)=>({step:'s'+i,ownerAction:'a',successCheck:'c',approvalRequired:false})) })), /3 to 6/);
});

test('rejects invalid timeboxes and empty required text', () => {
  assert.throws(() => validateAgentPlan(validPlan({ timeboxDays: 15 })), /timebox/);
  assert.throws(() => validateAgentPlan(validPlan({ objective: '  ' })), /objective/);
});

test('caps text and list lengths', () => {
  const result = validateAgentPlan(validPlan({ objective: 'x'.repeat(1500), assumptions: Array.from({length:12},()=> 'a') }));
  assert.equal(result.objective.length, 1000);
  assert.equal(result.assumptions.length, 8);
});

test('rejects unapproved internal operation types', () => {
  assert.throws(() => validateAgentPlan(validPlan({ operation: 'send_email' })), /Unsupported internal operation/);
});
