#!/usr/bin/env node
/**
 * One-off, idempotent migration: lift stale `<operation>.schedule.enabled`
 * values to `<operation>.enabled`.
 *
 * The previous PATCH handler wrote the toggle into the schedule object, which
 * no read path consumed. Documents touched by it carry a value that looks
 * authoritative and is not.
 *
 * HALTS on disagreement rather than choosing. Where both fields exist and
 * differ, silently picking one could enable a tenant the operator believes is
 * paused -- the failure class behind the 2026-08-03 incident. Those documents
 * are reported for a human decision.
 *
 *   node scripts/migrate-queue-enabled.js --dry-run
 *   node scripts/migrate-queue-enabled.js --confirm
 *   node scripts/migrate-queue-enabled.js --down --confirm
 */

const { MongoClient } = require('mongodb');

const COLLECTION = 'contentcreator_tenants';
const OPERATIONS = ['discovery', 'enrichment'];

const dryRun = !process.argv.includes('--confirm');
const down = process.argv.includes('--down');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('FAIL  MONGODB_URI is not set.');
    process.exit(2);
  }
  const client = await new MongoClient(uri).connect();
  const db = process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db();
  console.log(`Database: ${db.databaseName}${dryRun ? '  (DRY RUN)' : ''}`);

  const tenants = await db.collection(COLLECTION).find({}).toArray();
  const conflicts = [];
  const planned = [];

  for (const tenant of tenants) {
    for (const op of OPERATIONS) {
      const node = tenant[op];
      if (!node || typeof node !== 'object') continue;
      const stale = node.schedule && typeof node.schedule === 'object'
        ? node.schedule.enabled
        : undefined;
      const current = node.enabled;

      if (down) {
        if (typeof current === 'boolean') {
          planned.push({ tenantId: tenant.tenantId, op, action: 'restore', value: current });
        }
        continue;
      }

      if (stale === undefined) continue;
      if (current === undefined) {
        planned.push({ tenantId: tenant.tenantId, op, action: 'lift', value: stale });
      } else if (current !== stale) {
        conflicts.push({ tenantId: tenant.tenantId, op, current, stale });
      } else {
        planned.push({ tenantId: tenant.tenantId, op, action: 'clean', value: current });
      }
    }
  }

  if (conflicts.length > 0) {
    console.error('\nFAIL  Conflicting values found. Not guessing which is authoritative.');
    for (const c of conflicts) {
      console.error(`      ${c.tenantId}.${c.op}: enabled=${c.current} vs schedule.enabled=${c.stale}`);
    }
    console.error('\n      Resolve each by hand, then re-run.');
    await client.close();
    process.exit(1);
  }

  if (planned.length === 0) {
    console.log('ok    Nothing to migrate.');
    await client.close();
    return;
  }

  for (const p of planned) {
    console.log(`  ${p.action.padEnd(8)} ${p.tenantId}.${p.op} -> ${p.value}`);
    if (dryRun) continue;
    const update = down
      ? { $set: { [`${p.op}.schedule.enabled`]: p.value } }
      : { $set: { [`${p.op}.enabled`]: p.value }, $unset: { [`${p.op}.schedule.enabled`]: '' } };
    await db.collection(COLLECTION).updateOne({ tenantId: p.tenantId }, update);
  }

  console.log(dryRun ? '\nDry run. Re-run with --confirm to apply.' : `\nok    ${planned.length} applied.`);
  await client.close();
}

main().catch((err) => {
  console.error(`FAIL  ${err.message}`);
  process.exit(2);
});
