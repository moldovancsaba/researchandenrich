#!/usr/bin/env node
/**
 * run-cogmap-enrichment-lean.js — Lean enrichment runner for CogMap tenant.
 *
 * Reads a batch of leads from runs/cogmap-enrich-batch.json (or stdin),
 * applies enrichment via the SchemaMapper, and posts results to the
 * SalesLeadGenerator API with --command payload semantics (direct script
 * execution, no cold LLM agent).
 *
 * Usage:
 *   node run-cogmap-enrichment-lean.js
 *   node run-cogmap-enrichment-lean.js --cycles 1
 *   node run-cogmap-enrichment-lean.js --limit 5
 */
'use strict';

const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SchemaMapper = require(path.resolve(__dirname, 'schema-mapper.js'));

const TENANT = 'cogmap';
const MAX_RETRIES = 3;

/**
 * Load a tenant env file without a dependency.
 *
 * This used to be `require('dotenv')`, which is in neither `dependencies` nor
 * `node_modules` -- the runner died with MODULE_NOT_FOUND on a clean checkout
 * before doing any work. A dependency is not warranted for this: the files use
 * shell `export KEY="value"` syntax that `source` already handles, and the
 * repo's contract is that they are sourced.
 *
 * It also resolved the path as `__dirname/.env.cogmap`, i.e. inside the clone.
 * `prompts/RUNTIME_PATHS.md` is explicit that env files normally live OUTSIDE
 * it, which is why RAE_ENV_DIR exists. Resolution order here matches that
 * contract: RAE_ENV_DIR, then RAE_ROOT, then the clone as a last resort.
 *
 * Values already present in the environment are never overwritten, so an
 * operator who exports credentials directly does not need the file at all.
 */
function loadTenantEnv(tenantId) {
  const candidates = [
    process.env.RAE_ENV_DIR,
    process.env.RAE_ROOT,
    __dirname,
  ].filter(Boolean);

  for (const dir of candidates) {
    const file = path.join(dir, `.env.${tenantId}`);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      // Vercel-sourced values arrive quoted; `source` strips the quotes and a
      // naive parser does not -- a quoted key sent as a header produces a
      // misleading 401.
      const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return file;
  }
  return null;
}

const ENV_FILE = loadTenantEnv(TENANT);

function getEnvKey() {
  return process.env.SLG_API_KEY;
}

/**
 * Build the target URL through the mapper rather than hardcoding it.
 *
 * The previous constant was `https://salesleadgenerator.vercel.app/api/lead` --
 * singular, so every request 404'd. Hardcoding also bypassed getApiEndpoint's
 * identifier validation and percent-encoding (commit cf8573d), which exists
 * because record ids come from web-sourced agent output.
 *
 * getApiEndpoint also appends `?brand=<tenantId>`. That matters more than it
 * looks: salesleadgenerator's resolveBrand() defaults a MISSING brand to
 * 'cogmap', so a dropped query string is invisible for this tenant and would
 * silently write another tenant's records into cogmap's collection.
 */
function endpointFor(mapper, method, id) {
  return mapper.getApiEndpoint(TENANT, method.toLowerCase(), id || null);
}

function apiRequest(mapper, method, body, attempt = 0) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': getEnvKey(),
      'Content-Length': Buffer.byteLength(data),
    };
    const url = new URL(endpointFor(mapper, method, body && body.id));
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      // pathname + search: dropping the query string drops ?brand=.
      path: `${url.pathname}${url.search}`,
      method: method,
      headers: headers,
      timeout: 30000,
    };
    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(chunks)); } catch (e) { resolve({ raw: chunks }); }
        } else if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          setTimeout(() => apiRequest(mapper, method, body, attempt + 1).then(resolve).catch(reject), 5000 * (attempt + 1));
        } else {
          reject(new Error(`API ${method} failed: ${res.statusCode} ${chunks}`));
        }
      });
    });
    req.on('error', (e) => {
      if (attempt < MAX_RETRIES) {
        setTimeout(() => apiRequest(mapper, method, body, attempt + 1).then(resolve).catch(reject), 3000 * (attempt + 1));
      } else {
        reject(e);
      }
    });
    req.write(data);
    req.end();
  });
}

function loadBatch() {
  const batchPath = path.resolve(__dirname, 'runs', 'cogmap-enrich-batch.json');
  if (fs.existsSync(batchPath)) {
    return JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  }
  // Fallback: generate from discovery leads
  const leadsPath = path.resolve(__dirname, 'discovery_leads.js');
  if (fs.existsSync(leadsPath)) {
    // If discovery_leads.js exports an array, require it
    const mod = require(leadsPath);
    return Array.isArray(mod) ? mod : (mod.leads || []);
  }
  return [];
}

async function enrichRecord(mapper, rawLead) {
  const provider = mapper.mapToApiPayload('cogmap', rawLead, 'put');
  const validation = mapper.validateForTenant('cogmap', provider);
  if (!validation.valid) {
    return { skipped: true, errors: validation.errors, lead: rawLead.name || rawLead.id };
  }
  return { provider, skipped: false, errors: [], lead: rawLead.name || rawLead.id };
}

async function main() {
  const args = process.argv.slice(2);
  const cycles = args.includes('--cycles') ? parseInt(args[args.indexOf('--cycles') + 1] || '1') : 1;
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

  const mapper = new SchemaMapper();
  let batch = loadBatch();
  if (limit) batch = batch.slice(0, limit);

  console.log(`\n=== CogMap Enrichment (Lean)${process.env.SLG_API_KEY ? '' : ' [NO API KEY]'} ===`);
  console.log(`Source: ${path.resolve(__dirname, 'runs', 'cogmap-enrich-batch.json')}`);
  console.log(`Leads in batch: ${batch.length} (limit: ${limit || 'none'}, cycles: ${cycles})`);

  const stats = { posted: 0, skipped: 0, updated: 0, errors: 0 };
  const results = [];

  for (let cycle = 0; cycle < cycles; cycle++) {
    if (cycle > 0) {
      batch = loadBatch(); // reload each cycle
      if (limit) batch = batch.slice(0, limit);
    }
    for (const lead of batch) {
      try {
        const result = await enrichRecord(mapper, lead);
        if (result.skipped) {
          console.log(`  [skip] ${result.lead}: ${result.errors.join('; ')}`);
          stats.skipped++;
          continue;
        }
        // POST new or PUT existing based on whether it already has an API ID
        const method = result.provider.id ? 'PUT' : 'POST';
        const response = await apiRequest(mapper, method, result.provider);
        if (method === 'POST') {
          stats.posted++;
          console.log(`  ✓ POST ${result.lead} → ${response.id || response.id}`);
        } else {
          stats.updated++;
          console.log(`  ✓ PUT ${result.lead} → updated`);
        }
        results.push({ name: result.lead, id: response.id, action: method });
      } catch (e) {
        console.log(`  [error] ${lead.name || lead.id}: ${e.message}`);
        stats.errors++;
      }
    }
  }

  // Write results manifest
  const outPath = path.resolve(__dirname, 'runs', `cogmap-enrich-run-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ stats, results, batchSize: batch.length, cycles }, null, 2));
  console.log(`\n=== SUMMARY ===`);
  console.log(`Posted: ${stats.posted}, Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
  console.log(`Results manifest: ${outPath}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
