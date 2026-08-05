#!/usr/bin/env node
/**
 * Live integration test for the classscout program-api tenant.
 *
 * Unlike scripts/verify-schema-mapper.js (pure local logic, no network),
 * this exercises the REAL classscout deployment end to end: auth, ImgBB
 * upload, POST /api/ingest create, POST /api/ingest patch, and cleanup
 * delete. It's the direct diagnostic for "is INGEST_API_KEY actually
 * accepted by classscout.ai" -- the health-check mode alone answers that
 * without touching any data.
 *
 * Requires INGEST_API_KEY (and, for --mode=live, IMGBB_API_KEY) in the
 * environment -- source .env.classscout first:
 *   source .env.classscout && node scripts/test-classscout-live.js --mode=health
 *
 * Modes:
 *   --mode=health   (default-safe) GET /api/ingest only. No writes. Answers
 *                   the 401-vs-503 question directly.
 *   --mode=dry-run  Builds and validates sample discovery + enrichment
 *                   payloads via schema-mapper.js and prints them. No
 *                   network calls at all.
 *   --mode=live     Full round-trip against REAL production classscout.ai:
 *                   health check -> ImgBB upload -> create -> patch ->
 *                   delete (cleanup). Requires --confirm as well, since
 *                   this writes real (if clearly-marked, self-deleting)
 *                   data into the live catalog.
 */

const SchemaMapper = require('../schema-mapper');

const API_BASE = 'https://classscout.ai';
const TEST_ID = 'prov-researchandenrich-live-test';
// 1x1 transparent PNG, for the ImgBB upload step -- content doesn't matter,
// only that it's a real image ImgBB will accept and host.
const TEST_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a.startsWith('--mode=')) || '--mode=health').split('=')[1];
  const confirm = args.includes('--confirm');
  return { mode, confirm };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.startsWith('REPLACE_WITH_')) {
    console.error(`FAIL  ${name} is not set (or still a placeholder). Did you \`source .env.classscout\`?`);
    process.exit(1);
  }
  return v;
}

async function ingestRequest(method, body, ingestKey) {
  const res = await fetch(`${API_BASE}/api/ingest`, {
    method,
    headers: {
      Authorization: `Bearer ${ingestKey}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body; leave json null
  }
  return { status: res.status, ok: res.ok, body: json };
}

async function healthCheck(ingestKey) {
  console.log('--- Health check: GET /api/ingest ---');
  const { status, body } = await ingestRequest('GET', null, ingestKey);
  console.log(`  HTTP ${status}`);
  console.log(`  ${JSON.stringify(body)}`);
  if (status === 200) {
    console.log('  ok  INGEST_API_KEY is accepted.');
    return true;
  }
  if (status === 503) {
    console.log('  FAIL  503 = INGEST_API_KEY is not configured AT ALL on classscout.ai\'s deployment.');
    console.log('        Nobody has set the env var yet (or it was never redeployed).');
  } else if (status === 401) {
    console.log('  FAIL  401 = something IS configured server-side, but it does not match this key.');
    console.log('        Either a typo when it was set, or it\'s a different/older key than this one.');
  } else {
    console.log(`  FAIL  Unexpected status ${status} -- not a simple auth-configuration issue.`);
  }
  return false;
}

function buildSampleDiscoveryRecord(imageUrl) {
  return {
    id: TEST_ID,
    name: 'RESEARCHANDENRICH LIVE TEST -- SAFE TO DELETE',
    category: 'Classes',
    borough: 'Manhattan',
    neighborhood: 'Test Neighborhood',
    address: '123 Test Street, New York, NY 10001',
    activityTypes: ['Integration Test'],
    ageRanges: [],
    dayTimeTags: [],
    pricePerClass: 0,
    shortDescription: 'Automated integration test record for researchandenrich. Safe to delete.',
    longDescription:
      'This record was created automatically by researchandenrich\'s live integration test ' +
      'to verify the classscout ingest pipeline end to end (auth, image upload, create, patch, ' +
      'delete). It is expected to be deleted by the same test run immediately after.',
    image: imageUrl,
    website: 'https://example.com',
    email: '',
    phone: '',
  };
}

async function uploadTestImageToImgBB(imgbbKey) {
  console.log('--- Uploading test image to ImgBB ---');
  const params = new URLSearchParams({ key: imgbbKey, image: TEST_IMAGE_B64 });
  const res = await fetch(`https://api.imgbb.com/1/upload`, { method: 'POST', body: params });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.url) {
    console.log(`  FAIL  HTTP ${res.status}: ${JSON.stringify(json)}`);
    console.log('  This is an ImgBB-key/service issue, separate from the classscout ingest auth question.');
    return null;
  }
  console.log(`  ok  ${json.data.url}`);
  return json.data.url;
}

async function runDryRun(mapper) {
  console.log('=== DRY RUN (no network calls) ===\n');

  const createPayload = mapper.mapToApiPayload(
    'classscout',
    buildSampleDiscoveryRecord('https://i.ibb.co/PLACEHOLDER/test.png'),
    'post',
  );
  const createValidation = mapper.validateForTenant('classscout', createPayload);
  console.log('--- Discovery (create) payload ---');
  console.log(JSON.stringify(createPayload, null, 2));
  console.log(`Validation: ${createValidation.valid ? 'ok valid' : 'FAIL invalid'}`);
  if (!createValidation.valid) console.log(createValidation.errors.join('\n'));

  console.log('\n--- Enrichment (patch) payload ---');
  const patchPayload = mapper.mapToApiPayload(
    'classscout',
    { id: TEST_ID, phone: '+1-212-555-0100', tags: ['integration-test'] },
    'put',
  );
  const patchValidation = mapper.validateForTenant('classscout', patchPayload);
  console.log(JSON.stringify(patchPayload, null, 2));
  console.log(`Validation: ${patchValidation.valid ? 'ok valid' : 'FAIL invalid'}`);
  if (!patchValidation.valid) console.log(patchValidation.errors.join('\n'));

  const allValid = createValidation.valid && patchValidation.valid;
  console.log(`\n${allValid ? 'ok' : 'FAIL'}  Dry run ${allValid ? 'passed' : 'FAILED'} (no network calls made).`);
  process.exitCode = allValid ? 0 : 1;
}

async function runLive(mapper, ingestKey, imgbbKey) {
  console.log('=== LIVE integration test against classscout.ai (real writes, self-cleaning) ===\n');

  const healthy = await healthCheck(ingestKey);
  if (!healthy) {
    console.log('\nAborting -- fix the auth issue above before the write steps can be meaningfully tested.');
    process.exit(1);
  }

  const imageUrl = await uploadTestImageToImgBB(imgbbKey);
  if (!imageUrl) {
    console.log('\nAborting -- cannot test a real create without a real ImgBB-hosted image.');
    process.exit(1);
  }

  console.log('\n--- Step: create (discovery) ---');
  const createPayload = mapper.mapToApiPayload('classscout', buildSampleDiscoveryRecord(imageUrl), 'post');
  const createValidation = mapper.validateForTenant('classscout', createPayload);
  if (!createValidation.valid) {
    console.log('  FAIL  Local validation rejected the payload before sending:');
    console.log('  ' + createValidation.errors.join('\n  '));
    process.exit(1);
  }
  const createResult = await ingestRequest('POST', createPayload, ingestKey);
  console.log(`  HTTP ${createResult.status}: ${JSON.stringify(createResult.body)}`);
  const createOk = createResult.ok && createResult.body?.results?.[0]?.ok === true;
  console.log(`  ${createOk ? 'ok  create succeeded' : 'FAIL  create failed'}`);

  let patchOk = false;
  if (createOk) {
    console.log('\n--- Step: patch (enrichment) ---');
    const patchPayload = mapper.mapToApiPayload(
      'classscout',
      { id: TEST_ID, phone: '+1-212-555-0100', tags: ['integration-test'] },
      'put',
    );
    const patchValidation = mapper.validateForTenant('classscout', patchPayload);
    if (!patchValidation.valid) {
      console.log('  FAIL  Local validation rejected the patch before sending:');
      console.log('  ' + patchValidation.errors.join('\n  '));
    } else {
      const patchResult = await ingestRequest('POST', patchPayload, ingestKey);
      console.log(`  HTTP ${patchResult.status}: ${JSON.stringify(patchResult.body)}`);
      patchOk = patchResult.ok && patchResult.body?.results?.[0]?.ok === true;
      console.log(`  ${patchOk ? 'ok  patch succeeded' : 'FAIL  patch failed'}`);
    }
  } else {
    console.log('\n--- Step: patch (enrichment) --- SKIPPED (create failed, nothing to patch)');
  }

  console.log('\n--- Step: cleanup (delete test record) ---');
  if (createOk) {
    const deleteResult = await ingestRequest(
      'POST',
      { operations: [{ resource: 'provider', action: 'delete', id: TEST_ID }] },
      ingestKey,
    );
    console.log(`  HTTP ${deleteResult.status}: ${JSON.stringify(deleteResult.body)}`);
    const deleteOk = deleteResult.ok && deleteResult.body?.results?.[0]?.ok === true;
    console.log(`  ${deleteOk ? 'ok  test record deleted' : 'FAIL  cleanup delete failed -- ' + TEST_ID + ' may still be live, delete it manually'}`);
  } else {
    console.log('  SKIPPED (nothing was created).');
  }

  console.log('\n=== Summary ===');
  console.log(`  health check: ok`);
  console.log(`  image upload: ok`);
  console.log(`  create:       ${createOk ? 'ok' : 'FAIL'}`);
  console.log(`  patch:        ${createOk ? (patchOk ? 'ok' : 'FAIL') : 'skipped'}`);
  process.exitCode = createOk && (patchOk || !createOk) ? 0 : 1;
}

async function main() {
  const { mode, confirm } = parseArgs();
  const mapper = new SchemaMapper();

  if (mode === 'dry-run') {
    await runDryRun(mapper);
    return;
  }

  const ingestKey = requireEnv('INGEST_API_KEY');

  if (mode === 'health') {
    const healthy = await healthCheck(ingestKey);
    process.exitCode = healthy ? 0 : 1;
    return;
  }

  if (mode === 'live') {
    if (!confirm) {
      console.error(
        'FAIL  --mode=live requires --confirm as well -- this makes REAL writes into the live ' +
          'classscout.ai catalog (self-cleaning, but real). Re-run with both flags if that\'s intended:\n' +
          '  node scripts/test-classscout-live.js --mode=live --confirm',
      );
      process.exit(1);
    }
    const imgbbKey = requireEnv('IMGBB_API_KEY');
    await runLive(mapper, ingestKey, imgbbKey);
    return;
  }

  console.error(`Unknown --mode=${mode}. Use health, dry-run, or live.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('FAIL  Unexpected error:', err);
  process.exit(1);
});
