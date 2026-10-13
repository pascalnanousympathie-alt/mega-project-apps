#!/usr/bin/env node
'use strict';

// Planning/validation only: this CLI does not install plugins, sign in to accounts,
// run deployments, or claim that a remote runner executed a task.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'orchestration', 'plugins.registry.json');
const WORKFLOWS_PATH = path.join(ROOT, 'orchestration', 'workflows.json');
const ALLOWED_STATUSES = new Set([
  'connected',
  'requires_user_connection',
  'available',
  'external_manual',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig() {
  return {
    registry: readJson(REGISTRY_PATH),
    workflows: readJson(WORKFLOWS_PATH),
  };
}

function validateConfig(registry, workflows) {
  const errors = [];
  if (registry.schemaVersion !== 1) errors.push('unsupported registry schemaVersion');
  if (!Array.isArray(registry.integrations)) errors.push('registry.integrations must be an array');
  if (workflows.schemaVersion !== 1) errors.push('unsupported workflows schemaVersion');
  if (!Array.isArray(workflows.workflows)) errors.push('workflows.workflows must be an array');

  const integrationIds = new Set();
  for (const item of registry.integrations || []) {
    if (!item.id || !item.name) errors.push('each integration must have id and name');
    if (integrationIds.has(item.id)) errors.push('duplicate integration id: ' + item.id);
    integrationIds.add(item.id);
    if (!ALLOWED_STATUSES.has(item.status)) errors.push('invalid status for ' + item.id + ': ' + item.status);
    if (!Array.isArray(item.capabilities)) errors.push('capabilities must be an array: ' + item.id);
    if (item.status === 'requires_user_connection' && !item.connectionAction) {
      errors.push('missing connectionAction for ' + item.id);
    }
  }

  const workflowIds = new Set();
  for (const workflow of workflows.workflows || []) {
    if (!workflow.id || !workflow.name) errors.push('each workflow must have id and name');
    if (workflowIds.has(workflow.id)) errors.push('duplicate workflow id: ' + workflow.id);
    workflowIds.add(workflow.id);
    if (!Array.isArray(workflow.stages) || workflow.stages.length === 0) {
      errors.push('workflow must define at least one stage: ' + workflow.id);
      continue;
    }
    const stageIds = new Set();
    for (const stage of workflow.stages) {
      if (!stage.id || !stage.title) errors.push('each stage must have id and title in ' + workflow.id);
      if (stageIds.has(stage.id)) errors.push('duplicate stage id in ' + workflow.id + ': ' + stage.id);
      stageIds.add(stage.id);
      if (!Array.isArray(stage.integrations)) errors.push('stage integrations must be an array: ' + workflow.id + '/' + stage.id);
      for (const integrationId of stage.integrations || []) {
        if (!integrationIds.has(integrationId)) {
          errors.push('unknown integration ' + integrationId + ' in ' + workflow.id + '/' + stage.id);
        }
      }
    }
    if (/deploy|release/i.test(workflow.id) &&
        !workflow.stages.some(stage => stage.requiresApproval === true)) {
      errors.push('deployment/release workflow must include an approval stage: ' + workflow.id);
    }
  }
  return errors;
}

function buildPlan(registry, workflow) {
  const byId = new Map(registry.integrations.map(item => [item.id, item]));
  return workflow.stages.map(stage => {
    if (stage.requiresApproval) {
      return { stage, state: 'APPROVAL_REQUIRED', detail: 'Human approval required; not executed automatically.' };
    }
    const integrations = (stage.integrations || []).map(id => byId.get(id));
    const missing = integrations.filter(item => item.status === 'requires_user_connection');
    const unavailable = integrations.filter(item => item.status === 'available');
    const external = integrations.filter(item => item.status === 'external_manual');
    const connected = integrations.filter(item => item.status === 'connected');

    if (missing.length) {
      return { stage, state: stage.optional ? 'OPTIONAL_SKIPPED' : 'BLOCKED_CONNECTION',
        detail: 'Connect: ' + missing.map(item => item.name).join(', ') };
    }
    if (unavailable.length) {
      return { stage, state: stage.optional ? 'OPTIONAL_SKIPPED' : 'BLOCKED_OPTIONAL_TOOL',
        detail: 'Not connected/verified: ' + unavailable.map(item => item.name).join(', ') };
    }
    if (external.length) {
      return { stage, state: 'NEEDS_EXTERNAL_EVIDENCE',
        detail: 'External runner must execute and return evidence: ' + external.map(item => item.name).join(', ') };
    }
    if (connected.length === integrations.length) {
      return { stage, state: 'READY_TO_RUN', detail: 'Required integration is connected; execution and evidence still need confirmation.' };
    }
    return { stage, state: 'READY_TO_RUN', detail: 'No remote integration required for this approval-planning stage.' };
  });
}

function printStatus(registry) {
  console.log('Integration registry (snapshot; not a live connection probe)');
  for (const item of registry.integrations) {
    console.log(item.id + '\t' + item.status.toUpperCase() + '\t' + item.name);
  }
  const counts = registry.integrations.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  console.log('SUMMARY=' + JSON.stringify(counts));
}

function printPlan(registry, workflows, requestedId) {
  const selected = requestedId === 'all'
    ? workflows.workflows
    : workflows.workflows.filter(item => item.id === requestedId);
  if (!selected.length) {
    throw new Error('Unknown workflow: ' + requestedId + '. Known workflows: ' +
      workflows.workflows.map(item => item.id).join(', '));
  }
  let blocked = 0;
  for (const workflow of selected) {
    console.log('\nWORKFLOW ' + workflow.id + ' — ' + workflow.name);
    for (const row of buildPlan(registry, workflow)) {
      console.log('[' + row.state + '] ' + row.stage.id + ': ' + row.stage.title);
      console.log('  ' + row.detail);
      if (row.state.startsWith('BLOCKED_') || row.state === 'NEEDS_EXTERNAL_EVIDENCE') blocked++;
    }
  }
  console.log('\nPLAN_BLOCKERS=' + blocked);
  console.log('PLAN_ONLY=true');
  return blocked;
}

function main(argv) {
  const command = argv[2] || 'status';
  const { registry, workflows } = loadConfig();
  const errors = validateConfig(registry, workflows);

  if (command === 'check') {
    if (errors.length) {
      errors.forEach(error => console.error('ERROR: ' + error));
      console.error('ORCHESTRATOR_CHECK=FAIL');
      return 1;
    }
    console.log('INTEGRATIONS=' + registry.integrations.length);
    console.log('WORKFLOWS=' + workflows.workflows.length);
    console.log('ORCHESTRATOR_CHECK=PASS');
    console.log('EXECUTION_SIDE_EFFECTS=NONE');
    return 0;
  }

  if (errors.length) {
    errors.forEach(error => console.error('ERROR: ' + error));
    return 1;
  }

  if (command === 'status') {
    printStatus(registry);
    return 0;
  }
  if (command === 'plan') {
    if (!argv[3]) throw new Error('Usage: node scripts/plugin-workflow-manager.js plan <workflow-id|all>');
    printPlan(registry, workflows, argv[3]);
    return 0;
  }
  console.error('Usage: node scripts/plugin-workflow-manager.js <status|check|plan <workflow-id|all>>');
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error('PLUGIN_WORKFLOW_MANAGER=FAIL');
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { loadConfig, validateConfig, buildPlan };
