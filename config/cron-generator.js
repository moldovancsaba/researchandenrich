#!/usr/bin/env node
/**
 * Cron Generator - Generates config/cron.yaml from workers/<tenant>/discovery.yaml and enrichment.yaml
 *
 * Usage:
 *   node config/cron-generator.js
 *   node config/cron-generator.js --dry-run  (print without writing)
 *
 * Reads all YAML files from workers/<tenant>/ and generates config/cron.yaml.
 * Respects tenant status (paused/disabled tenants get disabled cron entries).
 * Respects per-operation enabled flags in tenants.json (discovery/enrichment can be toggled independently).
 */

const fs = require('fs');
const path = require('path');

const WORKERS_DIR = path.join(__dirname, '..', 'workers');
const TENANTS_FILE = path.join(__dirname, '..', 'tenants.json');
const OUTPUT_FILE = path.join(__dirname, 'cron.yaml');

function loadTenantConfig() {
  const raw = fs.readFileSync(TENANTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function loadWorkerYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Simple YAML parser for our limited schema
  // (For production, use a proper YAML library like js-yaml)
  const lines = raw.split('\n');
  const result = {};
  let currentKey = null;
  let currentList = [];
  let inList = false;
  let indent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle list items
    if (trimmed.startsWith('- ')) {
      currentList.push(trimmed.substring(2));
      inList = true;
      continue;
    }

    if (inList && currentKey) {
      // Continue collecting list items
      if (trimmed.startsWith('- ')) {
        currentList.push(trimmed.substring(2));
        continue;
      }
      // End of list
      result[currentKey] = currentList;
      currentList = [];
      inList = false;
      currentKey = null;
    }

    // Handle key-value pairs
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      // End previous list
      if (inList && currentKey) {
        result[currentKey] = currentList;
        currentList = [];
        inList = false;
        currentKey = null;
      }

      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();

      if (value === '' || value === '|') {
        // Nested object or multi-line - start new key
        currentKey = key;
        result[key] = {};
      } else if (value.startsWith('"') && value.endsWith('"')) {
        result[key] = value.slice(1, -1);
      } else if (!isNaN(value) && value !== '') {
        result[key] = Number(value);
      } else if (value === 'true') {
        result[key] = true;
      } else if (value === 'false') {
        result[key] = false;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        result[key] = value.slice(1, -1).split(',').map(s => s.trim());
      } else {
        result[key] = value;
      }
    }
  }

  // End any remaining list
  if (inList && currentKey) {
    result[currentKey] = currentList;
  }

  return result;
}

function generateCronEntry(tenantId, tenantConfig, operation, workerConfig) {
  const tenantStatus = tenantConfig.status || 'active';
  const isPaused = tenantStatus === 'paused' || tenantStatus === 'disabled';
  // Per-operation enabled flag: check tenants.json first, then worker YAML.
  const opConfig = tenantConfig[operation] || {};
  const opEnabled = opConfig.enabled !== false;

  return {
    worker: `${tenantId}-${operation}`,
    tenant: tenantId,
    app: tenantConfig.app,
    operation,
    prompt: workerConfig.prompt || `prompts/${operation}/${tenantId}.md`,
    cron: workerConfig.schedule?.cron || `*/45 * * * *`,
    tz: workerConfig.schedule?.tz || 'Europe/Budapest',
    enabled: !isPaused && opEnabled && workerConfig.enabled !== false,
    timeoutMs: workerConfig.timeoutMs || 300000,
    retry: workerConfig.retry || { maxAttempts: 3, backoffMs: 5000 },
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

    workers[tenantDir] = {};
    for (const file of operationFiles) {
      const operation = file.replace('.yaml', '');
      const filePath = path.join(tenantPath, file);
      workers[tenantDir][operation] = loadWorkerYaml(filePath);
      workers[tenantDir][operation]._filePath = filePath;
    }
  }

  return workers;
}

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
    if (!tenantWorkers) continue;

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
      lines.push(`      maxAttempts: ${entry.retry.maxAttempts || 3}`);
      lines.push(`      backoffMs: ${entry.retry.backoffMs || 5000}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const tenants = loadTenantConfig();
  const workers = discoverWorkers();

  console.log(`Found ${Object.keys(tenants.tenants || {}).length} tenants`);
  console.log(`Found ${Object.keys(workers).length} worker directories`);

  for (const [tenantId, workerOps] of Object.entries(workers)) {
    console.log(`  ${tenantId}: ${Object.keys(workerOps).join(', ')}`);
  }

  const cronYaml = generateCronYaml(tenants, workers);

  if (dryRun) {
    console.log('\n--- DRY RUN OUTPUT ---');
    console.log(cronYaml);
    console.log('--- END DRY RUN ---');
  } else {
    fs.writeFileSync(OUTPUT_FILE, cronYaml + '\n');
    console.log(`\nGenerated ${OUTPUT_FILE}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateCronYaml, discoverWorkers, loadTenantConfig };