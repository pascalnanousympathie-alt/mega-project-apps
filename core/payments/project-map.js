'use strict';

const MVOLA_PROJECTS = Object.freeze({
  domino: Object.freeze({ name: 'DominoMada', prefix: 'DOMINOMADA' }),
  loto: Object.freeze({ name: 'LotoMada', prefix: 'LOTOMADA' }),
  rami: Object.freeze({ name: 'RamiMada', prefix: 'RAMIMADA' }),
});

function normalizeMvolaProject(project) {
  const value = String(project || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MVOLA_PROJECTS, value) ? value : null;
}

function mvolaProjectEnv(project, field) {
  const key = normalizeMvolaProject(project);
  if (!key) return null;
  const spec = MVOLA_PROJECTS[key];
  const suffix = {
    consumerKey: 'CONSUMER_KEY',
    consumerSecret: 'CONSUMER_SECRET',
    apiKey: 'API_KEY',
    merchantNumber: 'PARTNER_MSISDN',
    partnerName: 'PARTNER_NAME',
  }[field];
  if (!suffix) return null;
  return `${spec.prefix}_MVOLA_${suffix}`;
}

function resolveMvolaProjectCredentials(project, env = {}) {
  const key = normalizeMvolaProject(project);
  if (!key) return null;
  const out = { project: key };
  for (const field of ['consumerKey', 'consumerSecret', 'apiKey', 'merchantNumber', 'partnerName']) {
    const envName = mvolaProjectEnv(key, field);
    if (envName && Object.prototype.hasOwnProperty.call(env, envName) && String(env[envName] || '').trim()) out[field] = env[envName];
  }
  if (!out.merchantNumber && Object.prototype.hasOwnProperty.call(env, 'MVOLA_PARTNER_MSISDN')) out.merchantNumber = env.MVOLA_PARTNER_MSISDN;
  if (!out.partnerName) out.partnerName = MVOLA_PROJECTS[key].name;
  return out;
}

module.exports = { MVOLA_PROJECTS, normalizeMvolaProject, mvolaProjectEnv, resolveMvolaProjectCredentials };
