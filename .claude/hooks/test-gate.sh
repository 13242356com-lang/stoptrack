#!/usr/bin/env bash
# StopTrack Stop-hook gate.
#
# Purpose: keep the "second agent checks the code" promise honest by refusing to
# let a turn END while the web app has uncommitted changes that don't pass the
# tests. This is the automated backstop behind the reviewer agent — the thing that
# would have caught a broken stop-report before it shipped.
#
# It is deliberately conservative: it ONLY runs when StopTrack.tsx or test/ have
# uncommitted changes AND the test toolchain is installed. Otherwise it exits 0
# (no-op) so ordinary chats and non-web work are never blocked.
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# Read the hook payload; never re-block inside a stop-hook continuation (avoids
# an infinite loop where the block itself triggers the hook again).
input="$(cat 2>/dev/null || true)"
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
esac

# Nothing web-facing changed since HEAD? Don't gate.
if git diff --quiet -- StopTrack.tsx test/ 2>/dev/null \
   && git diff --cached --quiet -- StopTrack.tsx test/ 2>/dev/null; then
  exit 0
fi

# No toolchain / deps not installed → can't run the test; don't block, just note.
command -v npm >/dev/null 2>&1 || exit 0
[ -d node_modules/playwright ] || { echo "test-gate: skipped (run 'npm install' to enable the web test gate)" >&2; exit 0; }

log="$(mktemp 2>/dev/null || echo /tmp/stoptrack-test-gate.log)"
if npm test >"$log" 2>&1; then
  exit 0
fi

{
  echo "Stop blocked: StopTrack.tsx/test changed but 'npm test' failed."
  echo "Fix the failure (or the test) before finishing this turn."
  echo "----- npm test output (tail) -----"
  tail -n 30 "$log"
} >&2
exit 2
