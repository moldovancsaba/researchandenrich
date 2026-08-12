#!/usr/bin/env node
/**
 * Guards against the exact failure mode that produced the 2026-08-03 incident
 * (see docs/RUNTIME_ARCHITECTURE_NOTES.md section 9): a commit scoped to one
 * tenant (e.g. "narrow classscout's scope") also silently paused two other,
 * unrelated tenants as a bundled side effect.
 *
 * IMPORTANT, verified the hard way: the incident commit's own message
 * ("Pause cogmap/seyu/dvsc; narrow classscout...") already NAMED every
 * tenant it touched -- so an earlier version of this script that only
 * required "every changed tenant must be named in the message" was tested
 * directly against that real commit and PASSED it. Naming isn't the actual
 * signal; a vague, routine-sounding mention of an unrelated tenant is just
 * as easy to skim past as no mention at all. The rule this script actually
 * enforces instead: **a single commit may change status/enabled for AT MOST
 * ONE tenant**, unless the commit message contains an explicit
 * `Multi-tenant-change: <reason>` trailer -- a structural, unmissable
 * acknowledgement that this specific commit is deliberately touching more
 * than one tenant, not a routine mention buried in prose. (Verified this
 * escape hatch is actually needed, not just theoretical: the real fix for
 * the 2026-08-03 incident itself -- restoring both cogmap and seyu in one
 * commit -- legitimately needs it, and was tested against an earlier,
 * escape-hatch-free version of this script, which correctly rejected it.)
 * This doesn't verify authorization (no mechanical diff check can) -- what
 * it does is remove the ability to bundle an unrelated, easy-to-miss tenant
 * change inside a commit that reads as being about something else entirely,
 * while still allowing genuine, deliberate multi-tenant commits through a
 * single explicit, greppable marker.
 *
 * Usage:
 *   node scripts/check-tenant-status-diff.js [<baseRef>] [<headRef>]
 *   node scripts/check-tenant-status-diff.js                 # HEAD^ vs HEAD
 *   node scripts/check-tenant-status-diff.js origin/main HEAD
 *
 * Exits non-zero (and prints a clear explanation) when the rule is violated.
 * Exits 0 (silently, unless --verbose) when tenants.json didn't change, or
 * changed for only one tenant, or changed for several tenants all named in
 * the commit message.
 */

const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

function readTenantsAtRef(ref) {
  try {
    const raw = run(`git show ${ref}:tenants.json`);
    return JSON.parse(raw).tenants || {};
  } catch {
    return {}; // ref didn't have tenants.json (e.g. the very first commit)
  }
}

function statusSignature(tenant) {
  if (!tenant) return null;
  return JSON.stringify({
    status: tenant.status,
    discoveryEnabled: tenant.discovery?.enabled,
    enrichmentEnabled: tenant.enrichment?.enabled,
  });
}

function findChangedTenants(before, after) {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const id of ids) {
    if (statusSignature(before[id]) !== statusSignature(after[id])) {
      changed.push(id);
    }
  }
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const positional = args.filter((a) => !a.startsWith('--'));
  const baseRef = positional[0] || 'HEAD^';
  const headRef = positional[1] || 'HEAD';

  const before = readTenantsAtRef(baseRef);
  const after = readTenantsAtRef(headRef);
  const changed = findChangedTenants(before, after);

  if (changed.length === 0) {
    if (verbose) console.log('ok  tenants.json status/enabled fields unchanged.');
    process.exit(0);
  }

  if (changed.length === 1) {
    if (verbose) console.log(`ok  Only one tenant's status/enabled changed (${changed[0]}).`);
    process.exit(0);
  }

  let message;
  try {
    message = run(`git log -1 --format=%B ${headRef}`);
  } catch {
    console.error(`FAIL  Could not read commit message for ${headRef}.`);
    process.exit(1);
  }

  const trailerMatch = message.match(/^Multi-tenant-change:\s*(.+)$/im);
  if (trailerMatch && trailerMatch[1].trim().length > 0) {
    if (verbose) {
      console.log(
        `ok  ${changed.length} tenants changed (${changed.join(', ')}) -- explicit ` +
          `"Multi-tenant-change:" trailer present: "${trailerMatch[1].trim()}"`,
      );
    }
    process.exit(0);
  }

  console.error(
    `FAIL  This commit changes status/enabled for ${changed.length} tenants in one commit: ${changed.join(', ')}.\n\n` +
      `A single commit may change at most ONE tenant's status/enabled fields -- this repo's rule ` +
      `since the 2026-08-03 incident (docs/RUNTIME_ARCHITECTURE_NOTES.md section 9), where a commit ` +
      `that DID name every tenant it touched ("Pause cogmap/seyu/dvsc; narrow classscout...") still ` +
      `let an unrelated, unauthorized tenant pause slip through unnoticed, because naming something ` +
      `isn't the same as it being reviewed.\n\n` +
      `Fix: split this into ${changed.length} separate commits, one per tenant (${changed.join(', ')}), ` +
      `each with its own message explaining that specific tenant's change -- OR, if this really is one ` +
      `deliberate, reviewed, multi-tenant change, add a trailer explaining why:\n\n` +
      `  Multi-tenant-change: <why this genuinely needs to touch ${changed.length} tenants at once>`,
  );
  process.exit(1);
}

main();
