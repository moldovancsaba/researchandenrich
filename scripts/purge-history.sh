#!/usr/bin/env bash
# Purges the 6 secret-bearing paths (issue #9) from every reachable commit
# and ref in this repo's history, per issue #10. Every check aborts before
# any remote mutation -- the remote is only ever touched by the final
# publish step, and only when --confirm-force-push is passed explicitly.
#
# MANDATORY precondition: scripts/assert-credentials-rotated.js must pass.
# Purging history before the exposed credentials are actually rotated
# destroys the record of the exposure while the secrets themselves stay
# live -- see docs/RUNTIME_ARCHITECTURE_NOTES.md and issue #10's own
# "Dependencies & Execution Order" section for why this is a hard gate,
# not a suggestion.
#
# Usage:
#   OLD_COGMAP_MONGODB_URI=... OLD_SEYU_MONGODB_URI=... OLD_SLG_API_KEY=... \
#     ./scripts/purge-history.sh --dry-run
#   OLD_COGMAP_MONGODB_URI=... OLD_SEYU_MONGODB_URI=... OLD_SLG_API_KEY=... \
#     ./scripts/purge-history.sh --confirm-force-push
#
# Requires: git-filter-repo (the maintained tool -- filter-branch is
# deprecated and error-prone per issue #10's own §11).

set -euo pipefail

REMOTE="${REMOTE:-https://github.com/moldovancsaba/researchandenrich.git}"
SECRET_PATHS=(.env.cogmap .env.cogmap.bak .env.check .env.prod .env.vercel .vercel/project.json)
SECRET_PATTERNS=('mongodb\+srv://[^:]+:[^@]+@' 'slg_[a-f0-9]{32}')

MODE="${1:-}"
if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--confirm-force-push" ]; then
  echo "Usage: $0 --dry-run | --confirm-force-push" >&2
  exit 1
fi

command -v git-filter-repo >/dev/null 2>&1 || {
  echo "FAIL  git-filter-repo is not installed. Install it before running this script." >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Phase 0: precondition -- are the exposed credentials actually rotated? ==="
node "$SCRIPT_DIR/assert-credentials-rotated.js"
echo

echo "=== Phase 1: mirror backup (mandatory before any rewrite) ==="
BACKUP_DIR="researchandenrich-backup-$(date -u +%Y%m%dT%H%M%SZ).git"
git clone --mirror "$REMOTE" "$BACKUP_DIR"
echo "ok    backup written to $BACKUP_DIR -- keep this offline and encrypted until rotation + purge are both confirmed, then destroy it"
echo

echo "=== Phase 2: fresh clone (git filter-repo requires one) ==="
WORKDIR="$(mktemp -d)"
git clone "$REMOTE" "$WORKDIR/rewrite"
cd "$WORKDIR/rewrite"
echo "ok    working clone at $WORKDIR/rewrite"
echo

echo "=== Phase 3: rewrite -- removing 6 secret-bearing paths from all reachable history ==="
PATH_ARGS=()
for p in "${SECRET_PATHS[@]}"; do
  PATH_ARGS+=(--path "$p")
done
git filter-repo --invert-paths "${PATH_ARGS[@]}"
echo "ok    filter-repo completed"
echo

echo "=== Phase 4: verify -- no reachable blob at any of the removed paths ==="
FAILED=0
for p in "${SECRET_PATHS[@]}"; do
  if git log --all --oneline -- "$p" | grep -q .; then
    echo "FAIL  path still reachable: $p" >&2
    FAILED=1
  else
    echo "ok    path removed: $p"
  fi
done
echo

echo "=== Phase 5: verify -- no reachable blob matches a known secret value pattern ==="
# A path can be renamed; a value cannot hide. This is the check that actually matters.
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(rest)' \
  | awk '$1=="blob" {print $2}' > /tmp/purge-history-blobs.txt
BLOB_COUNT=$(wc -l < /tmp/purge-history-blobs.txt)
echo "  scanning $BLOB_COUNT blobs for secret patterns..."
while read -r sha; do
  for pattern in "${SECRET_PATTERNS[@]}"; do
    if git cat-file blob "$sha" 2>/dev/null | grep -qE "$pattern"; then
      echo "FAIL  secret pattern '$pattern' found in blob $sha" >&2
      FAILED=1
    fi
  done
done < /tmp/purge-history-blobs.txt
rm -f /tmp/purge-history-blobs.txt
if [ "$FAILED" -eq 0 ]; then
  echo "ok    no secret patterns reachable in any blob"
fi
echo

if [ "$FAILED" -ne 0 ]; then
  echo "FAIL  verification failed -- aborting before any remote mutation. Local rewrite left at $WORKDIR/rewrite for inspection." >&2
  exit 1
fi

if [ "$MODE" == "--dry-run" ]; then
  echo "=== Dry run complete: all checks passed, nothing was pushed. ==="
  echo "Rewritten clone left at $WORKDIR/rewrite for inspection. Re-run with --confirm-force-push to publish."
  exit 0
fi

echo "=== Phase 6: publish -- force-pushing rewritten history to $REMOTE ==="
git push --force --all
git push --force --tags
echo "ok    force-push complete"
echo

echo "=== Done. Required follow-up (not automated by this script): ==="
echo "  1. Every other clone of this repo (including this sandbox and any other agent session)"
echo "     must re-clone or 'git fetch && git reset --hard origin/main' -- old clones can"
echo "     resurrect the removed history if they push."
echo "  2. Enable GitHub secret scanning + push protection on the repository."
echo "  3. Destroy the mirror backup ($BACKUP_DIR) once this is confirmed complete."
echo "  4. Update docs/RUNTIME_ARCHITECTURE_NOTES.md with a dated entry (what was purged,"
echo "     the commit-map if filter-repo produced one, and remap any pre-rewrite SHAs cited"
echo "     elsewhere in that document -- section 10 already flags several from the prior"
echo "     authorship rewrite that need the same treatment)."
