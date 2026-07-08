#!/usr/bin/env bash
# Install (or re-install) the self-hosted deploy stack on this box: copies the three systemd unit
# files into /etc/systemd/system, reloads systemd, and enables + starts them. Idempotent — safe to
# re-run after editing a unit or pulling new code.
#
#   sudo scripts/serve/setup.sh              # serve + watch + hook
#   sudo scripts/serve/setup.sh --no-hook    # skip the GitHub webhook listener
#
# The static server listens on 8059 and the webhook on 8060 (see the .service files). The webhook
# also needs a shared secret at ~/vidgrid-deploy-hook-secret (chmod 600) matching the GitHub webhook
# UI; the watcher works without it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="/etc/systemd/system"

UNITS=(vidgrid-serve.service vidgrid-watch.service)
WANT_HOOK=1
for arg in "$@"; do
    case "$arg" in
        --no-hook) WANT_HOOK=0 ;;
        *) echo "unknown arg: $arg" >&2; exit 1 ;;
    esac
done
[ "$WANT_HOOK" -eq 1 ] && UNITS+=(vidgrid-hook.service)

if [ "$(id -u)" -ne 0 ]; then
    echo "This script installs systemd units — re-run with sudo." >&2
    exit 1
fi

for unit in "${UNITS[@]}"; do
    echo "==> installing $unit"
    cp "$HERE/$unit" "$UNIT_DIR/$unit"
done

systemctl daemon-reload
systemctl enable --now "${UNITS[@]}"

echo
echo "Enabled: ${UNITS[*]}"
echo "Status:"
for unit in "${UNITS[@]}"; do
    systemctl --no-pager --lines=0 status "$unit" || true
done

if [ "$WANT_HOOK" -eq 1 ] && [ ! -s "$HOME/vidgrid-deploy-hook-secret" ]; then
    echo
    echo "NOTE: no webhook secret at $HOME/vidgrid-deploy-hook-secret — the hook will reject pushes"
    echo "      until you create it (chmod 600) with the same secret set in the GitHub webhook UI."
    echo "      The watcher still auto-deploys without it."
fi
