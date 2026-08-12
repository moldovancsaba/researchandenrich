#!/usr/bin/env node
/**
 * Cron Generator - Generates config/cron.yaml from workers/<tenant>/discovery.yaml
 * and workers/<tenant>/enrichment.yaml.
 *
 * Usage:
 *   node config/cron-generator.js              write config/cron.yaml
 *   node config/cron-generator.js --dry-run    print without writing
 *   node config/cron-generator.js --check      exit 1 if the committed file is stale
 *
 * Reads every tenant's worker YAML plus tenants.json and emits the master cron
 * schedule. Respects tenant status (paused/disabled tenants get disabled cron
 * entries) and the per-operation enabled flags in tenants.json.
 *
 * PARSING: this used to use a hand-rolled line parser that silently flattened
 * nested mappings -- `schedule:`, `retry:` and `healthCheck:` each produced an
 * empty object while their children were hoisted to the top level. The practical
 * effect was that workerConfig.schedule?.cron was always undefined, so every
 * entry fell through to the hardcoded default and editing a worker YAML had no
 * effect on the output. Parsing is now delegated to js-yaml. See
 * docs/RUNTIME_ARCHITECTURE_NOTES.md for the full finding.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKERS_DIR = path.join(__dirname, '..', 'workers');
const TENANTS_FILE = path.join(__dirname, '..', 'tenants.json');
const OUTPUT_FILE = path.join(__dirname, 'cron.yaml');

const DEFAULT_CRON = '*/45 * * * *';
const DEFAULT_TZ = 'Europe/Budapest';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: 5000 };

// Deduped: entries are derived twice (once to emit, once for the summary), and
// the same file warning printed twice reads as two distinct problems.
const warnings = new Set();
function warn(message) {
  if (warnings.has(message)) return;
  warnings.add(message);
  console.warn(`WARN  ${message}`);
}

function loadTenantConfig() {
  const raw = fs.readFileSync(TENANTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Parse a worker YAML file. JSON_SCHEMA is passed explicitly so no custom type
 * construction is ever enabled, regardless of what a future js-yaml default does.
 */
function loadWorkerYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let doc;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA, filename: filePath });
  } catch (err) {
    throw new Error(`${filePath}: invalid YAML -- ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${filePath}: expected a YAML mapping at the document root`);
  }
  return doc;
}

const REQUIRED_KEYS = ['tenant', 'operation', 'prompt', 'schedule'];

function validateWorkerConfig(doc, filePath) {
  for (const key of REQUIRED_KEYS) {
    if (doc[key] === undefined) {
      throw new Error(`${filePath}: missing required key '${key}'`);
    }
  }
  if (!['discovery', 'enrichment'].includes(doc.operation)) {
    throw new Error(
      `${filePath}: 'operation' must be 'discovery' or 'enrichment', got '${doc.operation}'`
    );
  }
  const schedule = doc.schedule;
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error(`${filePath}: 'schedule' must be a mapping`);
  }
  if (schedule.cron === undefined && typeof schedule.everyMs !== 'number') {
    throw new Error(
      `${filePath}: 'schedule' needs either a 'cron' expression or a numeric 'everyMs'`
    );
  }
  if (doc.retry !== undefined && (doc.retry === null || typeof doc.retry !== 'object')) {
    throw new Error(`${filePath}: 'retry' must be a mapping when present`);
  }
  return doc;
}

/**
 * Convert an interval to a cron expression.
 *
 * Standard cron can only express a step that divides evenly into an hour, or a
 * whole number of hours. An interval that does not (45 minutes, say) has no
 * faithful cron form: `*​/45 * * * *` fires at :00 and :45, i.e. a 45-minute gap
 * followed by a 15-minute one, NOT every 45 minutes.
 *
 * Every worker file currently specifies everyMs: 2700000 (45 minutes), and the
 * previous generator emitted `*​/45 * * * *` for it -- so that uneven cadence is
 * what is running in production today. Rather than silently change live
 * scheduling, an inexpressible interval keeps emitting the legacy `*​/N` form and
 * warns loudly with the real firing pattern. Deciding between changing the
 * interval to an expressible value, declaring schedule.cron explicitly, or
 * teaching the consumer to take everyMs natively is an owner decision, not one
 * to make silently inside a parser fix.
 */
function everyMsToCron(everyMs, filePath) {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(`${filePath}: 'everyMs' must be a positive number, got ${everyMs}`);
  }
  if (everyMs % 60000 !== 0) {
    throw new Error(
      `${filePath}: 'everyMs' must be a whole number of minutes, got ${everyMs}`
    );
  }
  const minutes = everyMs / 60000;

  if (minutes < 60) {
    if (60 % minutes !== 0) {
      warn(
        `${filePath}: everyMs of ${minutes}m is not expressible as a standard cron step ` +
        `(60 is not divisible by ${minutes}). Emitting the legacy "*/${minutes} * * * *", ` +
        `which fires at minute 0 and minute ${minutes} of every hour -- a ${minutes}-minute ` +
        `gap followed by a ${60 - minutes}-minute one, not a ${minutes}-minute interval. ` +
        `Set schedule.cron explicitly to remove this ambiguity.`
      );
    }
    return `*/${minutes} * * * *`;
  }
  if (minutes % 60 !== 0) {
    warn(
      `${filePath}: everyMs of ${minutes}m is not a whole number of hours. ` +
      `Set schedule.cron explicitly.`
    );
    return `*/${minutes} * * * *`;
  }
  const hours = minutes / 60;
  return hours === 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

function resolveCron(workerConfig, filePath) {
  const schedule = workerConfig.schedule || {};
  if (schedule.cron) {
    if (typeof schedule.everyMs === 'number') {
      warn(`${filePath}: both 'cron' and 'everyMs' present; 'cron' wins.`);
    }
    return { cron: schedule.cron, source: 'explicit' };
  }
  if (typeof schedule.everyMs === 'number') {
    return { cron: everyMsToCron(schedule.everyMs, filePath), source: 'everyMs' };
  }
  warn(`${filePath}: no schedule resolved; falling back to "${DEFAULT_CRON}".`);
  return { cron: DEFAULT_CRON, source: 'default' };
}

function generateCronEntry(tenantId, tenantConfig, operation, workerConfig) {
  const tenantStatus = tenantConfig.status || 'active';
  const isPaused = tenantStatus === 'paused' || tenantStatus === 'disabled';
  // Per-operation enabled flag: tenants.json is authoritative, worker YAML may veto.
  const opConfig = tenantConfig[operation] || {};
  const opEnabled = opConfig.enabled !== false;

  const filePath = workerConfig._filePath || `${tenantId}/${operation}.yaml`;
  const { cron, source } = resolveCron(workerConfig, filePath);
  const retry = workerConfig.retry || {};

  return {
    worker: `${tenantId}-${operation}`,
    tenant: tenantId,
    app: tenantConfig.app,
    operation,
    prompt: workerConfig.prompt || `prompts/${operation}/${tenantId}.md`,
    cron,
    cronSource: source,
    tz: (workerConfig.schedule && workerConfig.schedule.tz) || DEFAULT_TZ,
    enabled: !isPaused && opEnabled && workerConfig.enabled !== false,
    enabledReason: isPaused
      ? `tenant status is '${tenantStatus}'`
      : !opEnabled
        ? `tenants.json ${operation}.enabled is false`
        : workerConfig.enabled === false
          ? 'worker YAML enabled is false'
          : 'active',
    timeoutMs: workerConfig.timeoutMs || DEFAULT_TIMEOUT_MS,
    retry: {
      maxAttempts: retry.maxAttempts || DEFAULT_RETRY.maxAttempts,
      backoffMs: retry.backoffMs || DEFAULT_RETRY.backoffMs,
    },
  };
}

function discoverWorkers() {
  const workers = {};

  if (!fs.existsSync(WORKERS_DIR)) {
    console.error('Workers directory not found:', WORKERS_DIR);
    process.exit(1);
  }

  const tenantDirs = fs.readdirSync(WORKERS_DIR).filter(
    f => fs.statSync(path.join(WORKERS_DIR, f)).isDirectory()
  );

  for (const tenantDir of tenantDirs) {
    const tenantPath = path.join(WORKERS_DIR, tenantDir);
    const operationFiles = fs.readdirSync(tenantPath).filter(f => f.endsWith('.yaml'));

    if (operationFiles.length === 0) {
      warn(`workers/${tenantDir}/ contains no .yaml files; tenant will produce no entries.`);
    }

    workers[tenantDir] = {};
    for (const file of operationFiles) {
      const operation = file.replace('.yaml', '');
      const filePath = path.join(tenantPath, file);
      const doc = validateWorkerConfig(loadWorkerYaml(filePath), filePath);
      doc._filePath = filePath;
      workers[tenantDir][operation] = doc;
    }
  }

  return workers;
}

/**
 * Emit the cron schedule.
 *
 * The emitted key set is deliberately unchanged from the previous generator.
 * Now that the parser works, `dependencies` and `healthCheck` are finally
 * readable from the worker files -- but adding them to the output would change
 * a contract consumed by the OpenClaw runtime, which cannot be verified from
 * inside this repo. They stay unemitted until that contract is confirmed.
 */
function generateCronYaml(tenants, workers) {
  const lines = [];
  lines.push('# Master Cron Schedule - Auto-generated from worker definitions');
  lines.push('# Do not edit manually — run `node config/cron-generator.js` to regenerate');
  lines.push('# Source of truth: workers/*/ discovery.yaml and workers/*/enrichment.yaml');
  lines.push('# Generated by: config/cron-generator.js');
  lines.push('');
  lines.push('schedule:');

  for (const [tenantId, tenantConfig] of Object.entries(tenants.tenants || {})) {
    const tenantWorkers = workers[tenantId];
    if (!tenantWorkers) {
      warn(`tenants.json declares '${tenantId}' but workers/${tenantId}/ does not exist.`);
      continue;
    }

    for (const [operation, config] of Object.entries(tenantWorkers)) {
      const entry = generateCronEntry(tenantId, tenantConfig, operation, config);

      lines.push(`  - worker: ${entry.worker}`);
      lines.push(`    tenant: ${entry.tenant}`);
      lines.push(`    app: ${entry.app}`);
      lines.push(`    operation: ${entry.operation}`);
      lines.push(`    prompt: ${entry.prompt}`);
      lines.push(`    cron: "${entry.cron}"`);
      lines.push(`    tz: "${entry.tz}"`);
      lines.push(`    enabled: ${entry.enabled}`);
      lines.push(`    timeoutMs: ${entry.timeoutMs}`);
      lines.push(`    retry:`);
      lines.push(`      maxAttempts: ${entry.retry.maxAttempts}`);
      lines.push(`      backoffMs: ${entry.retry.backoffMs}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Orphan check: a worker directory with no matching tenants.json entry. */
function reportOrphanWorkers(tenants, workers) {
  const declared = new Set(Object.keys(tenants.tenants || {}));
  for (const tenantId of Object.keys(workers)) {
    if (!declared.has(tenantId)) {
      warn(`workers/${tenantId}/ exists but '${tenantId}' is not in tenants.json; skipped.`);
    }
  }
}

function printSummary(tenants, workers) {
  console.log('');
  console.log('  worker                          cron              source    enabled');
  console.log('  ------------------------------  ----------------  --------  -------');
  for (const [tenantId, tenantConfig] of Object.entries(tenants.tenants || {})) {
    const tenantWorkers = workers[tenantId];
    if (!tenantWorkers) continue;
    for (const [operation, config] of Object.entries(tenantWorkers)) {
      const e = generateCronEntry(tenantId, tenantConfig, operation, config);
      console.log(
        `  ${e.worker.padEnd(30)}  ${e.cron.padEnd(16)}  ${e.cronSource.padEnd(8)}  ` +
        `${String(e.enabled).padEnd(5)} (${e.enabledReason})`
      );
    }
  }
  console.log('');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const check = process.argv.includes('--check');

  const tenants = loadTenantConfig();
  const workers = discoverWorkers();
  reportOrphanWorkers(tenants, workers);

  console.log(`Found ${Object.keys(tenants.tenants || {}).length} tenants`);
  console.log(`Found ${Object.keys(workers).length} worker directories`);

  for (const [tenantId, workerOps] of Object.entries(workers)) {
    console.log(`  ${tenantId}: ${Object.keys(workerOps).join(', ')}`);
  }

  const cronYaml = generateCronYaml(tenants, workers);
  printSummary(tenants, workers);

  if (check) {
    const committed = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf-8') : '';
    if (committed.trim() !== (cronYaml + '\n').trim()) {
      console.error('FAIL  config/cron.yaml is stale. Run `node config/cron-generator.js`.');
      process.exit(1);
    }
    console.log('ok    config/cron.yaml is current.');
    return;
  }

  if (dryRun) {
    console.log('--- DRY RUN OUTPUT ---');
    console.log(cronYaml);
    console.log('--- END DRY RUN ---');
  } else {
    fs.writeFileSync(OUTPUT_FILE, cronYaml + '\n');
    console.log(`Generated ${OUTPUT_FILE}`);
  }

  if (warnings.size > 0) {
    console.log(`\n${warnings.size} warning(s) -- see WARN lines above.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  generateCronYaml,
  discoverWorkers,
  loadTenantConfig,
  loadWorkerYaml,
  validateWorkerConfig,
  everyMsToCron,
  resolveCron,
};
