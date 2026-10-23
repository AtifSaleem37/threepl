#!/usr/bin/env bash
# Redeploy script for 3PL Prep Portal
#
# Pulls the latest code, reinstalls dependencies only when the lockfile moved,
# restarts the service, and health-checks it — automatically rolling back to the
# previous commit if the new build fails to come up.
#
# Run as: sudo bash deploy/redeploy.sh [options]
#
# Use setup.sh for the FIRST install on a fresh box; use this for every update after.

set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/threepl}"
APP_USER="${APP_USER:-ubuntu}"
SERVICE_NAME="${SERVICE_NAME:-threepl}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups}"
STATE_DIR="${STATE_DIR:-/var/lib/threepl-deploy}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
HEALTH_PATH="${HEALTH_PATH:-/clients}"     # login page - 200 without a session
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"     # ~20s of grace for boot + schema migrations

BRANCH=""
FORCE=0
SKIP_BACKUP=0
DO_ROLLBACK=0

# ---- output helpers ---------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; N=""
fi
step() { echo "${B}==> [$1/8] $2${N}"; }
info() { echo "    $*"; }
ok()   { echo "    ${G}✓${N} $*"; }
warn() { echo "    ${Y}!${N} $*"; }
die()  { echo "    ${R}✗ $*${N}" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo bash deploy/redeploy.sh [options]

  --branch <name>   Deploy this branch instead of the current one
  --force           Redeploy even when there is nothing new to pull
  --skip-backup     Do not snapshot data/ before deploying (not recommended)
  --rollback        Roll back to the commit running before the last redeploy
  -h, --help        Show this help

Environment overrides: APP_DIR, APP_USER, SERVICE_NAME, BACKUP_DIR
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)      BRANCH="${2:-}"; [ -n "$BRANCH" ] || die "--branch needs a value"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --rollback)    DO_ROLLBACK=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage; die "Unknown option: $1" ;;
  esac
done

# Run git/npm as the service user so file ownership stays correct.
run_as_app() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $1"; }
git_app() { run_as_app "git $1"; }

# ---- [1/8] pre-flight -------------------------------------------------------
step 1 "Pre-flight checks"
[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash deploy/redeploy.sh)"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout — run deploy/setup.sh first"
id "$APP_USER" &>/dev/null || die "User '$APP_USER' does not exist"
command -v node &>/dev/null || die "node is not installed — run deploy/setup.sh first"
systemctl list-unit-files "${SERVICE_NAME}.service" --no-legend | grep -q . \
  || die "systemd unit ${SERVICE_NAME}.service not installed — run deploy/setup.sh first"

# The app reads PORT at boot; the health check must use the same one.
PORT=$(sed -nE 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'"'"']?([0-9]+).*/\1/p' \
  "$APP_DIR/.env" 2>/dev/null | tail -1)
PORT="${PORT:-3000}"

CURRENT=$(git_app "rev-parse HEAD")
CURRENT_SHORT=${CURRENT:0:8}
info "App       : $APP_DIR (user $APP_USER)"
info "Service   : $SERVICE_NAME on port $PORT"
info "At commit : $CURRENT_SHORT  $(git_app "log -1 --pretty=%s")"
ok "Ready"

# ---- [2/8] resolve target ---------------------------------------------------
step 2 "Resolving target revision"
if [ "$DO_ROLLBACK" -eq 1 ]; then
  [ -f "$STATE_DIR/previous-commit" ] || die "No previous deploy recorded — nothing to roll back to"
  TARGET=$(cat "$STATE_DIR/previous-commit")
  git_app "cat-file -e ${TARGET}^{commit}" 2>/dev/null || die "Recorded commit $TARGET no longer exists"
  info "Rolling back to ${TARGET:0:8}"
else
  if [ -z "$BRANCH" ]; then
    BRANCH=$(git_app "rev-parse --abbrev-ref HEAD")
    # A previous --rollback leaves a detached HEAD. Resolve the default branch
    # from local refs only — never shell out to anything that prints the remote
    # URL, which may carry an access token.
    if [ "$BRANCH" = "HEAD" ]; then
      BRANCH=$(git_app "symbolic-ref --quiet --short refs/remotes/origin/HEAD" 2>/dev/null | sed 's|^origin/||') || true
      if [ -z "$BRANCH" ]; then
        for candidate in main master; do
          if git_app "rev-parse --verify --quiet refs/remotes/origin/$candidate >/dev/null"; then
            BRANCH="$candidate"; break
          fi
        done
      fi
      [ -n "$BRANCH" ] || die "Detached HEAD and no default branch found — pass --branch <name>"
      info "Detached HEAD — defaulting to branch '$BRANCH'"
    fi
  fi
  info "Fetching origin/$BRANCH ..."
  git_app "fetch --quiet --prune origin" || die "git fetch failed — check network and repo access"
  git_app "rev-parse --verify --quiet origin/$BRANCH >/dev/null" \
    || die "origin/$BRANCH does not exist"
  TARGET=$(git_app "rev-parse origin/$BRANCH")

  if [ "$TARGET" = "$CURRENT" ] && [ "$FORCE" -eq 0 ]; then
    ok "Already up to date with origin/$BRANCH — nothing to deploy"
    info "Service is $(systemctl is-active "$SERVICE_NAME"). Use --force to redeploy anyway."
    exit 0
  fi
  AHEAD=$(git_app "rev-list --count ${CURRENT}..${TARGET}" 2>/dev/null || echo "?")
  info "Deploying ${TARGET:0:8} ($AHEAD new commit(s))"
  git_app "log --oneline --no-decorate ${CURRENT}..${TARGET}" 2>/dev/null | head -10 | sed 's/^/      /' || true
fi
ok "Target resolved"

# ---- [3/8] back up data/ ----------------------------------------------------
# Schema migrations run automatically on boot (src/db.js rebuilds tables), so the
# snapshot below is the real safety net — git can't restore the SQLite database.
step 3 "Backing up data/"
BACKUP_FILE=""
if [ "$SKIP_BACKUP" -eq 1 ]; then
  warn "Skipped (--skip-backup) — a failed migration would be unrecoverable"
elif [ ! -d "$APP_DIR/data" ]; then
  info "No data/ directory yet — nothing to back up"
else
  mkdir -p "$BACKUP_DIR"
  chown "$APP_USER:$APP_USER" "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/threepl-$(date +%Y%m%d-%H%M%S)-${CURRENT_SHORT}.tgz"
  # Checkpoint the WAL first so the tarball holds a complete database.
  if command -v sqlite3 &>/dev/null && [ -f "$APP_DIR/data/portal.db" ]; then
    sudo -u "$APP_USER" sqlite3 "$APP_DIR/data/portal.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 \
      || warn "WAL checkpoint failed — backing up anyway"
  fi
  tar czf "$BACKUP_FILE" -C "$APP_DIR" data
  chown "$APP_USER:$APP_USER" "$BACKUP_FILE"
  ok "$BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
  # Keep the most recent N snapshots.
  ls -1t "$BACKUP_DIR"/threepl-*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    rm -f "$old"; info "pruned $(basename "$old")"
  done
fi

# ---- [4/8] update code ------------------------------------------------------
step 4 "Updating code"
mkdir -p "$STATE_DIR"
echo "$CURRENT" > "$STATE_DIR/previous-commit"

if ! git_app "diff --quiet" || ! git_app "diff --cached --quiet"; then
  warn "Local uncommitted changes detected — stashing them"
  git_app "stash push --quiet --include-untracked -m 'redeploy $(date +%F-%T)'" || true
fi

if [ "$DO_ROLLBACK" -eq 1 ]; then
  git_app "checkout --quiet --force $TARGET"
else
  git_app "checkout --quiet --force $BRANCH"
  git_app "merge --ff-only --quiet $TARGET" || die "Fast-forward merge failed — the server has diverging commits"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ok "Now at $(git_app "rev-parse --short HEAD")  $(git_app "log -1 --pretty=%s")"

# ---- [5/8] dependencies -----------------------------------------------------
step 5 "Dependencies"
install_deps() {
  info "Running npm ci --omit=dev ..."
  run_as_app "npm ci --omit=dev --no-audit --no-fund" || return 1
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/node_modules"
}
DEPS_CHANGED=0
if [ ! -d "$APP_DIR/node_modules" ]; then
  info "node_modules missing"
  DEPS_CHANGED=1
elif ! git_app "diff --quiet $CURRENT HEAD -- package.json package-lock.json"; then
  info "package.json / package-lock.json changed"
  DEPS_CHANGED=1
fi
if [ "$DEPS_CHANGED" -eq 1 ]; then
  install_deps || die "npm ci failed"
  ok "Dependencies installed"
else
  ok "Unchanged — skipped install"
fi

# ---- [6/8] config drift -----------------------------------------------------
step 6 "Checking config drift"
# New .env.example keys that the live .env is missing (the app reads env at boot).
if [ -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
  MISSING_KEYS=$(comm -23 \
    <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$APP_DIR/.env.example" | tr -d '=' | sort -u) \
    <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$APP_DIR/.env"         | tr -d '=' | sort -u) || true)
  if [ -n "$MISSING_KEYS" ]; then
    warn "New keys in .env.example not present in .env:"
    echo "$MISSING_KEYS" | sed 's/^/        /'
  else
    ok ".env has every key from .env.example"
  fi
fi

# systemd unit is ours to own, so reinstall it when it changes.
if ! git_app "diff --quiet $CURRENT HEAD -- deploy/threepl.service"; then
  info "deploy/threepl.service changed — reinstalling unit"
  cp "$APP_DIR/deploy/threepl.service" "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  ok "systemd unit updated"
fi

# nginx config is NOT auto-copied: setup.sh patched server_name into it and certbot
# rewrote it for TLS. Overwriting would drop the certificate config.
if ! git_app "diff --quiet $CURRENT HEAD -- deploy/nginx.conf"; then
  warn "deploy/nginx.conf changed in this release but was NOT applied."
  info "  Live config has your server_name + certbot TLS block. Merge by hand:"
  info "  diff /etc/nginx/sites-available/$SERVICE_NAME $APP_DIR/deploy/nginx.conf"
fi

# ---- [7/8] restart ----------------------------------------------------------
step 7 "Restarting $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 1
info "Service is $(systemctl is-active "$SERVICE_NAME")"

# ---- [8/8] health check -----------------------------------------------------
step 8 "Health check"
health_check() {
  local i code
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      warn "Service died during startup"
      return 1
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:${PORT}${HEALTH_PATH}" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      ok "HTTP $code from 127.0.0.1:${PORT}${HEALTH_PATH} (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  warn "No healthy response after ${HEALTH_RETRIES}s (last status: ${code:-000})"
  return 1
}

if health_check; then
  echo ""
  echo "=============================="
  echo " ${G}Redeploy complete${N}"
  echo " Commit  : $(git_app "rev-parse --short HEAD")  $(git_app "log -1 --pretty=%s")"
  [ -n "$BACKUP_FILE" ] && echo " Backup  : $BACKUP_FILE"
  echo " Service : systemctl status $SERVICE_NAME"
  echo " Logs    : journalctl -u $SERVICE_NAME -f"
  echo " Undo    : sudo bash deploy/redeploy.sh --rollback"
  echo "=============================="
else
  echo ""
  warn "Deploy failed its health check — rolling back to $CURRENT_SHORT"
  journalctl -u "$SERVICE_NAME" -n 25 --no-pager | sed 's/^/      /'
  echo ""

  git_app "checkout --quiet --force $CURRENT" || die "Rollback checkout failed — box needs manual repair"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  [ "$DEPS_CHANGED" -eq 1 ] && install_deps
  systemctl restart "$SERVICE_NAME"

  if health_check; then
    echo ""
    echo "=============================="
    echo " ${Y}Deploy rolled back${N} — service is healthy on $CURRENT_SHORT"
    [ -n "$BACKUP_FILE" ] && echo " Data backup : $BACKUP_FILE"
    echo " The new build is broken; check the logs above before retrying."
    echo "=============================="
    exit 1
  fi

  echo ""
  echo "=============================="
  echo " ${R}ROLLBACK ALSO FAILED — service is DOWN${N}"
  echo " Logs        : journalctl -u $SERVICE_NAME -n 100 --no-pager"
  [ -n "$BACKUP_FILE" ] && echo " Restore data: tar xzf $BACKUP_FILE -C $APP_DIR"
  echo "=============================="
  exit 1
fi
