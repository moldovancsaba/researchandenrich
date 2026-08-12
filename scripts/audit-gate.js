#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Wraps `npm audit --omit=dev` for both packages and fails on any advisory
 * EXCEPT a small, explicitly baselined set of known-accepted ones.
 *
 * Why not just run `npm audit`: the root package carries one high-severity
 * advisory whose only fix is a breaking major (see BASELINE below). A gate that
 * is permanently red trains people to ignore it, so the accepted advisory is
 * named here and everything else -- including a NEW high on the same package --
 * fails hard.
 *
 * Every baseline entry must carry a reason and a removal condition. An entry
 * without one is a silent exemption, which is the thing this file exists to
 * prevent.
 */

const { execFileSync } = require('node:child_process');
const path = require('path');

const PACKAGES = [
  { name: 'root', cwd: path.join(__dirname, '..') },
  {
    name: 'search-router',
    cwd: path.join(__dirname, '..', 'search-router', 'seyu-search-router'),
  },
];

const BASELINE = [
  {
    package: 'next',
    scope: 'root',
    reason:
      'No 14.x release fixes it; npm reports fixAvailable as next@16.3.0, a breaking major. '
      + 'Covers HTTP request smuggling in rewrites, Image Optimizer DoS, RSC deserialization '
      + 'DoS and cache poisoning. Exposure is reduced by App Router routes being force-dynamic '
      + 'and by the App Router surface being tiny after the dashboard removal.',
    removeWhen: 'the Next.js 16 major migration lands, or a 14.x backport ships',
    documented: 'docs/RUNTIME_ARCHITECTURE_NOTES.md §15',
  },
];

function audit(pkg) {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: pkg.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero when advisories exist; the JSON is still on stdout.
    raw = err.stdout;
    if (!raw) throw err;
  }
  return JSON.parse(raw);
}

let failures = 0;
let baselined = 0;

for (const pkg of PACKAGES) {
  const report = audit(pkg);
  const vulns = Object.entries(report.vulnerabilities || {});

  if (vulns.length === 0) {
    console.log(`  ok    ${pkg.name}: 0 advisories`);
    continue;
  }

  for (const [name, v] of vulns) {
    const accepted = BASELINE.find((b) => b.package === name && b.scope === pkg.name);
    if (accepted) {
      baselined++;
      console.log(`  WARN  ${pkg.name}: ${name} (${v.severity}) — accepted, see ${accepted.documented}`);
      console.log(`        remove this baseline when ${accepted.removeWhen}`);
      continue;
    }
    failures++;
    console.error(`  FAIL  ${pkg.name}: ${name} (${v.severity}) is not baselined`);
    console.error(`        fix: ${JSON.stringify(v.fixAvailable)}`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} un-baselined advisory/advisories. Fix them, or add an explicit`);
  console.error('baseline entry with a reason and a removal condition in scripts/audit-gate.js.');
  process.exit(1);
}
console.log(`Audit gate passed (${baselined} baselined, 0 un-baselined).`);
