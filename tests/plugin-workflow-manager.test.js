'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig, buildPlan } = require('../scripts/plugin-workflow-manager');

test('orchestration registry and workflow definitions validate', () => {
  const { registry, workflows } = loadConfig();
  assert.deepEqual(validateConfig(registry, workflows), []);
  assert.ok(registry.integrations.length >= 10);
  assert.ok(workflows.workflows.length >= 6);
});

test('every workflow stage references a known integration', () => {
  const { registry, workflows } = loadConfig();
  const ids = new Set(registry.integrations.map(item => item.id));
  for (const workflow of workflows.workflows) {
    for (const stage of workflow.stages) {
      for (const id of stage.integrations) assert.ok(ids.has(id), id);
    }
  }
});

test('planner respects current connection state and blocks a deliberately disconnected integration', () => {
  const { registry, workflows } = loadConfig();
  const workflow = workflows.workflows.find(item => item.id === 'fast-code');
  const activePlan = buildPlan(registry, workflow);
  assert.equal(activePlan.find(item => item.stage.id === 'docs').state, 'READY_TO_RUN');
  assert.equal(activePlan.find(item => item.stage.id === 'tdd').state, 'READY_TO_RUN');

  const simulatedRegistry = structuredClone(registry);
  simulatedRegistry.integrations.find(item => item.id === 'context7').status = 'requires_user_connection';
  const blockedPlan = buildPlan(simulatedRegistry, workflow);
  assert.equal(blockedPlan.find(item => item.stage.id === 'docs').state, 'BLOCKED_CONNECTION');
});

test('available design references are runnable, but real 3D validation needs external evidence', () => {
  const { registry, workflows } = loadConfig();
  const workflow = workflows.workflows.find(item => item.id === '3d-pipeline');
  const plan = buildPlan(registry, workflow);
  assert.equal(plan.find(item => item.stage.id === 'reference').state, 'READY_TO_RUN');
  assert.equal(plan.find(item => item.stage.id === 'target-validation').state, 'NEEDS_EXTERNAL_EVIDENCE');
});

test('deployment and release flows require an explicit approval stage', () => {
  const { registry, workflows } = loadConfig();
  for (const workflow of workflows.workflows.filter(item => /deploy|release/i.test(item.id))) {
    assert.ok(workflow.stages.some(stage => stage.requiresApproval === true), workflow.id);
    const plan = buildPlan(registry, workflow);
    assert.ok(plan.some(item => item.state === 'APPROVAL_REQUIRED'), workflow.id);
  }
});

test('Mada Commander readiness stays blocked until MCP and remote-runner evidence exists', () => {
  const { registry, workflows } = loadConfig();
  const workflow = workflows.workflows.find(item => item.id === 'mada-commander-readiness');
  const plan = buildPlan(registry, workflow);
  assert.equal(plan.find(item => item.stage.id === 'mcp-health-and-smoke').state, 'NEEDS_EXTERNAL_EVIDENCE');
  assert.equal(plan.find(item => item.stage.id === 'termux-bridge').state, 'NEEDS_EXTERNAL_EVIDENCE');
  assert.equal(plan.find(item => item.stage.id === 'readiness-approval').state, 'APPROVAL_REQUIRED');
});

test('invalid integration references are reported by the validator', () => {
  const { registry, workflows } = loadConfig();
  const broken = structuredClone(workflows);
  broken.workflows[0].stages[0].integrations.push('not-real');
  assert.ok(validateConfig(registry, broken).some(message => message.includes('unknown integration not-real')));
});
