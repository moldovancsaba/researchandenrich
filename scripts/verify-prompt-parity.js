#!/usr/bin/env node
/**
 * Regression gate: the sales-lead-api prompts must carry an identical field contract.
 *
 * cogmap, seyu and dvsc are one schemaFamily. They differ in business logic — scope,
 * ICP, forecast model — and in nothing else. On 2026-08-12 a live audit found 22 of 68
 * fields diverging by more than 50% across the three (sportCode 90/84/0%, contacts
 * 31/100/100%, contactEmails 4/30/95%), because only seyu's prompt ever listed the
 * fields to collect. Nothing detected it: the mapper passes the payload through as-is,
 * so a field the prompt never asks for is simply absent, and absence looked like "that
 * tenant doesn't have it".
 *
 * This gate makes that drift a build failure instead of a slow corruption of every
 * cross-tenant comparison.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'prompts/shared/sales-lead-fields.md');
const START = '<!-- shared:sales-lead-fields start -->';
const END = '<!-- shared:sales-lead-fields end -->';

const SALES_LEAD_TENANTS = ['cogmap', 'seyu', 'dvsc'];
const OTHER_FAMILY = ['classscout']; // program-api: must NOT carry this block

let failed = 0;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); failed++; };
const ok = (msg) => console.log(`  ok    ${msg}`);

if (!fs.existsSync(SHARED)) {
  console.error(`Missing SSOT: ${SHARED}`);
  process.exit(1);
}
const canonical = fs.readFileSync(SHARED, 'utf8').trim();

if (!canonical.startsWith(START) || !canonical.trimEnd().endsWith(END)) {
  fail('shared/sales-lead-fields.md must be wrapped in the start/end markers');
}

function extractBlock(file) {
  const text = fs.readFileSync(file, 'utf8');
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i === -1 || j === -1) return null;
  return text.slice(i, j + END.length).trim();
}

for (const op of ['discovery', 'enrichment']) {
  for (const tenant of SALES_LEAD_TENANTS) {
    const file = path.join(ROOT, `prompts/${op}/${tenant}.md`);
    if (!fs.existsSync(file)) { fail(`${op}/${tenant}.md is missing`); continue; }
    const block = extractBlock(file);
    if (block === null) {
      fail(`${op}/${tenant}.md does not carry the shared field contract`);
    } else if (block !== canonical) {
      fail(`${op}/${tenant}.md has drifted from prompts/shared/sales-lead-fields.md`);
    } else {
      ok(`${op}/${tenant}.md matches the shared field contract`);
    }
  }
}

// The block is sales-lead-api only. classscout is program-api and must not inherit it.
for (const op of ['discovery', 'enrichment']) {
  for (const tenant of OTHER_FAMILY) {
    const file = path.join(ROOT, `prompts/${op}/${tenant}.md`);
    if (fs.existsSync(file) && extractBlock(file) !== null) {
      fail(`${op}/${tenant}.md carries the sales-lead-api block but is a different schemaFamily`);
    } else {
      ok(`${op}/${tenant}.md correctly excluded (different schemaFamily)`);
    }
  }
}

// Legacy brand fields must not be reintroduced anywhere in the three.
for (const op of ['discovery', 'enrichment']) {
  for (const tenant of SALES_LEAD_TENANTS) {
    const file = path.join(ROOT, `prompts/${op}/${tenant}.md`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const block = extractBlock(file) || '';
    const outside = text.replace(block, '');
    const legacy = outside.match(/\b(pro|con)_for_(cogmap|seyu|dvsc)\b/g);
    if (legacy) {
      const uniq = [...new Set(legacy)];
      // The tenant block legitimately names its own forbidden fields; only flag a
      // tenant naming its OWN brand field as something to emit.
      const own = uniq.filter((f) => f.endsWith(`_${tenant}`));
      if (own.length && !/Forbidden fields/.test(outside)) {
        fail(`${op}/${tenant}.md still references legacy brand field(s): ${own.join(', ')}`);
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} parity check(s) failed.`);
  process.exit(1);
}
console.log('\nPrompt parity verified: cogmap/seyu/dvsc share one field contract.');
