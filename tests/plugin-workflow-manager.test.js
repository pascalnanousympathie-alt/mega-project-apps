'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig, buildPlan } = require('../scripts/plugin-workflow-manager');

test('orchestration registry and workflow definitions validate', () => {
  const { registry, workflows } = loadConfig();
  assert.deepEqual(validateConfig(registry, workflows), []);
  assert.ok(registry.integrations.length >= 10);
  assert.ok(workflows.workflows.length >= 5);
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

test('unconnected integrations are blocked while connected integrations remain usable', () => {
  const { registry, workflows } = loadConfig();
  const workflow = workflows.workflows.find(item => item.id === 'fast-code');
  const plan = buildPlan(registry, workflow);
  assert.equal(plan.find(item => item.stage.id === 'docs').state, 'BLOCKED_CONNECTION');
  assert.equal(plan.find(item => item.stage.id === 'tdd').state, 'READY_TO_RUN');
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

test('invalid integration references are reported by the validator', () => {
  const { registry, workflows } = loadConfig();
  const broken = structuredClone(workflows);
  broken.workflows[0].stages[0].integrations.push('not-real');
  assert.ok(validateConfig(registry, broken).some(message => message.includes('unknown integration not-real')));
});
