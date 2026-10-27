#!/usr/bin/env bash
# session-start.sh — SessionStart hook: bring the directives toolkit to current
# at the start of every web session.
#
# Why this exists: the toolkit is *installed* software, not text read from the
# repo, so a merged plugin change reaches a session only when its install runs
# again. Sourcing that install from the environment's Setup script made the
# cache key a per-environment setting no pull request could touch — a fix could
# merge and still not arrive until the owner re-saved that script by hand. This
# hook lives in the repo, so a merge delivers it.
#
# Best-effort by contract: it must never fail a session start. Every failure
# path warns on stderr and exits 0 — a stale toolkit is a degraded session,
# an aborted hook is no session at all.
#
# Web only. CLI/desktop installs stay manual per global.md -> Skill Bootstrap.
# pipefail: `… | bash` otherwise reports only the exit status of bash. The
# fetch runs as its own step, so a blocked fetch can never pass as an
# empty, successful run; pipefail stays as the guard for any pipe added later.
set -u
set -o pipefail

# Bounds. A SessionStart hook runs synchronously, so an unreachable host must
# cost seconds, not a TCP timeout: a session stuck at startup is worse than the
# stale toolkit this hook exists to prevent. curl gets connect/transfer caps and
# the whole updater gets a wall-clock cap, since `claude plugin update` performs
# its own network I/O and can hang the same way.
CURL_BOUNDS="--connect-timeout 5 --max-time 60"
RUN_CAP=180

RAW_URL="https://raw.githubusercontent.com/akyachtsman/claude.directives/main/scripts/install-toolkit.sh"
LOCAL="${CLAUDE_PROJECT_DIR:-$(pwd)}/scripts/install-toolkit.sh"

# Only run in Claude Code on the web; a local machine installs once by hand.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The install needs the CLI that owns the plugin cache.
if ! command -v claude >/dev/null 2>&1; then
  echo "session-start: 'claude' not on PATH — skipping toolkit install." >&2
  exit 0
fi

# In claude.directives itself the installer is a tracked file; downstream
# projects have no copy, so fall back to the published one. Identical script
# either way, which is what lets this hook ship byte-identical everywhere.
#
# `scripts/install-toolkit.sh` is a generic enough path that a downstream project
# can legitimately own an unrelated one. Running that at every session start would
# do arbitrary work AND skip the toolkit update, so the local fast path is taken
# only when the file identifies itself as ours.
if [ -r "$LOCAL" ] && grep -q 'install the claude.directives toolkit' "$LOCAL"; then
  timeout "$RUN_CAP" bash "$LOCAL" || echo "session-start: toolkit install failed (local) — continuing with the cached toolkit." >&2
else
  # Fetch first, run second, so a failed fetch is told apart from a failed
  # install: only the fetch has a fallback.
  # shellcheck disable=SC2086 # CURL_BOUNDS is a deliberate word-split flag list
  if script=$(curl -fsSL $CURL_BOUNDS "$RAW_URL"); then
    printf '%s\n' "$script" | timeout "$RUN_CAP" bash || echo "session-start: toolkit install failed (fetch) — continuing with the cached toolkit." >&2
  else
    # A private claude.directives answers raw reads with 404, while git still
    # reaches it from a session it is attached to. So refresh (or register) the
    # marketplace clone over git and run the installer it carries — taken, like
    # the local copy above, only when the file identifies itself as ours.
    CLONE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/claude-directives/scripts/install-toolkit.sh"
    timeout 60 claude plugin marketplace update claude-directives >/dev/null 2>&1 \
      || timeout 60 claude plugin marketplace add akyachtsman/claude.directives >/dev/null 2>&1 \
      || echo "session-start: raw fetch failed and the marketplace could not be refreshed over git — trying the clone on disk." >&2
    if [ -r "$CLONE" ] && grep -q 'install the claude.directives toolkit' "$CLONE"; then
      timeout "$RUN_CAP" bash "$CLONE" || echo "session-start: toolkit install failed (git) — continuing with the cached toolkit." >&2
    else
      echo "session-start: toolkit install failed (fetch, and no git copy) — continuing with the cached toolkit." >&2
    fi
  fi
fi

exit 0
