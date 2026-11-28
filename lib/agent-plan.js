'use strict';

const MAX_TEXT = 1000;
function boundedText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid plan field: ' + field);
  return value.trim().slice(0, max);
}
function boundedList(value, field, maxItems = 8) {
  if (!Array.isArray(value)) throw new Error('Invalid plan list: ' + field);
  return value.slice(0, maxItems).map((item, index) => boundedText(item, field + '[' + index + ']', 500));
}
function validateAgentPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Planner output must be a JSON object.');
  if (!Array.isArray(input.steps) || input.steps.length < 3 || input.steps.length > 6) {
    throw new Error('A valid plan must contain 3 to 6 steps.');
  }
  const steps = input.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid plan step ' + index + '.');
    if (typeof step.approvalRequired !== 'boolean') throw new Error('Every plan step must explicitly state approvalRequired.');
    return {
      step: boundedText(step.step, 'steps.step', 500),
      ownerAction: boundedText(step.ownerAction, 'steps.ownerAction', 500),
      successCheck: boundedText(step.successCheck, 'steps.successCheck', 500),
      // All external or financial operations remain blocked pending a separate owner approval.
      approvalRequired: step.approvalRequired
    };
  });
  const budget = Number(input.budgetCapUsd);
  if (!Number.isFinite(budget) || budget < 0 || budget > 0) {
    throw new Error('Plans must have a zero-dollar budget until spending permissions are implemented.');
  }
  const days = Number(input.timeboxDays);
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Plan timebox must be an integer from 1 to 14 days.');
  const operation = boundedText(input.operation, 'operation', 80);
  if (operation !== 'review_workspace_evidence') throw new Error('Unsupported internal operation.');
  return {
    operation,
    objective: boundedText(input.objective, 'objective'),
    assumptions: boundedList(input.assumptions || [], 'assumptions'),
    steps,
    successMetric: boundedText(input.successMetric, 'successMetric', 300),
    target: boundedText(input.target, 'target', 300),
    budgetCapUsd: 0,
    timeboxDays: days,
    risks: boundedList(input.risks || [], 'risks'),
    nextAction: boundedText(input.nextAction, 'nextAction', 500)
  };
}
module.exports = { validateAgentPlan };
