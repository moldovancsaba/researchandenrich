#!/usr/bin/env node
// Precondition gate for scripts/purge-history.sh (issue #10). Refuses to let
// a history purge proceed while any of the exposed credentials (issue #9)
// still authenticate -- purging git history before rotation destroys the
// audit trail of the exposure while leaving the actual secrets live, which
// is a worse outcome than doing nothing.
//
// No secret value is ever hardcoded here. Every credential this checks is
// read from an env var supplied by the operator at run time, and only
// pass/fail plus a masked identifier is ever printed -- never the value.
//
// Required env vars (all three -- this refuses to run with any missing,
// rather than silently skip a check):
//   OLD_COGMAP_MONGODB_URI   the exposed .env.cogmap COGMAP_MONGODB_URI value
//   OLD_SEYU_MONGODB_URI     the exposed .env.cogmap SEYU_MONGODB_URI value
//   OLD_SLG_API_KEY          the exposed .env.cogmap SLG_API_KEY value
// Optional:
//   SLG_API_BASE             default https://salesleadgenerator.vercel.app
//
// Usage: node scripts/assert-credentials-rotated.js
// Exit 0 only if every old credential is confirmed dead (rejected).
// Exit 1 if any old credential still authenticates, or any required env
// var is missing.

const { MongoClient } = require('mongodb');

const SLG_API_BASE = process.env.SLG_API_BASE || 'https://salesleadgenerator.vercel.app';

function mask(value) {
  if (!value) return '(unset)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function checkMongoUriDead(label, uri) {
  if (!uri) {
    console.error(`  FAIL  ${label}: required env var is not set -- cannot verify, refusing to assume dead`);
    return false;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    console.error(`  FAIL  ${label} (${mask(uri)}): still authenticates -- NOT rotated`);
    return false;
  } catch (err) {
    console.log(`  ok    ${label} (${mask(uri)}): rejected -- ${err.codeName || err.name || 'auth failure'}`);
    return true;
  } finally {
    await client.close().catch(() => {});
  }
}

async function checkSlgKeyDead(label, key) {
  if (!key) {
    console.error(`  FAIL  ${label}: required env var is not set -- cannot verify, refusing to assume dead`);
    return false;
  }
  try {
    const res = await fetch(`${SLG_API_BASE}/api/leads?brand=cogmap&limit=1`, {
      headers: { 'x-api-key': key },
    });
    if (res.status === 401 || res.status === 403) {
      console.log(`  ok    ${label} (${mask(key)}): rejected with HTTP ${res.status} -- rotated`);
      return true;
    }
    console.error(`  FAIL  ${label} (${mask(key)}): HTTP ${res.status} -- still authenticates, NOT rotated`);
    return false;
  } catch (err) {
    console.error(`  FAIL  ${label}: request failed (${err.message}) -- cannot verify, refusing to assume dead`);
    return false;
  }
}

async function main() {
  console.log('=== Precondition check: are the exposed credentials (issue #9) actually dead? ===\n');

  const results = await Promise.all([
    checkMongoUriDead('OLD_COGMAP_MONGODB_URI', process.env.OLD_COGMAP_MONGODB_URI),
    checkMongoUriDead('OLD_SEYU_MONGODB_URI', process.env.OLD_SEYU_MONGODB_URI),
    checkSlgKeyDead('OLD_SLG_API_KEY', process.env.OLD_SLG_API_KEY),
  ]);

  const allDead = results.every(Boolean);
  console.log(`\n${allDead ? 'ok' : 'FAIL'}  ${results.filter(Boolean).length}/${results.length} old credentials confirmed dead.`);

  if (!allDead) {
    console.error('\nRotation is not complete (or not verifiable). Refusing to let a history purge proceed.');
    process.exit(1);
  }
  console.log('\nAll old credentials confirmed dead. Safe to proceed with scripts/purge-history.sh.');
}

main().catch((err) => {
  console.error('FAIL  unexpected error:', err.message);
  process.exit(1);
});
