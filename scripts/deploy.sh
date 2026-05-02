#!/usr/bin/env bash
# Déploiement manuel (Linux / macOS / Git Bash / WSL).
# Usage : ./scripts/deploy.sh   ou   bash scripts/deploy.sh --push
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/deploy.local.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Créez deploy.local.env (voir deploy.local.env.example)." >&2
  exit 1
fi

# Charge deploy.local.env (format KEY=VAL)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${DEPLOY_HOST:?}"
: "${DEPLOY_USER:?}"
: "${DEPLOY_PATH:?}"

PUSH=0
BRANCH="main"
SKIP_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --branch=*) BRANCH="${arg#*=}" ;;
  esac
done

command -v git >/dev/null || { echo "git requis"; exit 1; }
command -v ssh >/dev/null || { echo "ssh requis"; exit 1; }

if [[ "$PUSH" -eq 1 ]]; then
  git push origin "$BRANCH"
fi

TMP="$(mktemp /tmp/cave-deploy-XXXXXX.tar)"
git archive --format=tar -o "$TMP" HEAD

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
REMOTE_TAR="/tmp/cave-deploy-$(date +%s).tar"

scp "$TMP" "${REMOTE}:${REMOTE_TAR}"
rm -f "$TMP"

ssh "$REMOTE" "tar -xf ${REMOTE_TAR} -C \"${DEPLOY_PATH}\" && rm -f ${REMOTE_TAR}"

if [[ "$SKIP_RESTART" -eq 0 && -n "${RESTART_SERVICE:-}" ]]; then
  ssh "$REMOTE" "sudo systemctl restart ${RESTART_SERVICE}" || true
fi

echo "Déploiement terminé."
