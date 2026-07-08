#!/usr/bin/env bash
# Poll origin/BRANCH every POLL_SECONDS and re-run `yarn deploy-local` whenever the remote advances.
# Runs forever as a systemd service (scripts/serve/vidgrid-watch.service). Deliberately unaware of
# the build clone / target root — that's deployLib's job. It only decides *when* to build.
#
# This is the self-healing fallback for missed webhooks; the webhook (vidgrid-hook.service) is the
# fast path. Env:
#   POLL_SECONDS  seconds between fetches (default 30)
#   PROJECT_ROOT  path to the source repo (default /root/video)
#   BRANCH        branch to track (default main)
#   LOG_PREFIX    string to prepend to log lines (default [watch])

set -u
set -o pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/root/video}"
BRANCH="${BRANCH:-main}"
POLL_SECONDS="${POLL_SECONDS:-30}"
LOG_PREFIX="${LOG_PREFIX:-[watch]}"

log() { printf "%s %s %s\n" "$LOG_PREFIX" "$(date -Iseconds)" "$*"; }

cd "$PROJECT_ROOT" || { log "cannot cd $PROJECT_ROOT"; exit 1; }

log "watching $PROJECT_ROOT branch=$BRANCH poll=${POLL_SECONDS}s"

last_sha=""
while true; do
    if ! git fetch origin "$BRANCH" -q 2>/dev/null; then
        log "git fetch failed, retrying in ${POLL_SECONDS}s"
        sleep "$POLL_SECONDS"
        continue
    fi
    remote_sha="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")"
    if [ -z "$remote_sha" ]; then
        log "could not resolve origin/$BRANCH"
        sleep "$POLL_SECONDS"
        continue
    fi
    if [ "$remote_sha" != "$last_sha" ]; then
        log "new $BRANCH tip $remote_sha (was ${last_sha:-none}) — deploying"
        # deploy-local reads and builds from origin/BRANCH in the isolated build clone; it does NOT
        # touch $PROJECT_ROOT's working tree, so the dev checkout stays untouched.
        if yarn deploy-local "$BRANCH"; then
            log "deploy complete for $remote_sha"
            last_sha="$remote_sha"
        else
            log "deploy FAILED for $remote_sha — will retry on next fetch"
        fi
    fi
    sleep "$POLL_SECONDS"
done
