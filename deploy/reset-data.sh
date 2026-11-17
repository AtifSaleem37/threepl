#!/usr/bin/env bash
#
# Wipe operational data, keeping the admin account and the rate card.
#
#   sudo bash deploy/reset-data.sh           asks for confirmation
#   sudo bash deploy/reset-data.sh --yes     no prompt (for scripted use)
#
# REMOVES   every non-admin user, all client orders and their items, shipping
#           labels, every purchase order with its items and history, all
#           notifications, per-client rate overrides, and every uploaded file
#           (invoices, FNSKU labels, payment proofs, shipping labels, PO photos).
# KEEPS     admin accounts, the global rate card and the volume discount tiers.
#
# This cannot be undone. A tarball of data/ is written first regardless.

set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/threepl}"
APP_USER="${APP_USER:-ubuntu}"
SERVICE_NAME="${SERVICE_NAME:-threepl}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups}"
DB="$APP_DIR/data/portal.db"
ASSUME_YES=0

if [ -t 1 ]; then B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else B=""; R=""; G=""; Y=""; N=""; fi
step() { echo "${B}==> $1${N}"; }
info() { echo "    $*"; }
ok()   { echo "    ${G}✓${N} $*"; }
warn() { echo "    ${Y}!${N} $*"; }
die()  { echo "    ${R}✗ $*${N}" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ---- checks ----------------------------------------------------------------
step "Checking"
[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash deploy/reset-data.sh)"
[ -f "$DB" ] || die "No database at $DB"
command -v sqlite3 >/dev/null || die "sqlite3 is not installed (apt-get install -y sqlite3)"

ADMINS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE role='admin';")
[ "$ADMINS" -ge 1 ] || die "No admin account found - refusing to wipe, you would be locked out"
ok "$ADMINS admin account(s) will be kept:"
sqlite3 "$DB" "SELECT '      '||username FROM users WHERE role='admin' ORDER BY id;"

count() { sqlite3 "$DB" "SELECT COUNT(*) FROM $1;" 2>/dev/null || echo 0; }
files_in() { ls -1 "$APP_DIR/data/$1" 2>/dev/null | wc -l | tr -d ' '; }

echo
step "About to delete"
printf "    %-26s %s\n" "non-admin users"        "$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE role<>'admin';")"
for t in orders order_items shipping_labels purchase_orders po_items po_events notifications client_rates; do
  printf "    %-26s %s\n" "$t" "$(count $t)"
done
for d in invoices fnsku payments shiplabels po-photos; do
  printf "    %-26s %s file(s)\n" "data/$d" "$(files_in $d)"
done
echo
info "Keeping: admin account(s), rate card, discount tiers."

if [ "$ASSUME_YES" -ne 1 ]; then
  echo
  printf "    ${R}This cannot be undone.${N} Type ${B}WIPE${N} to continue: "
  read -r answer
  [ "$answer" = "WIPE" ] || die "Cancelled - nothing was changed"
fi

# ---- backup ----------------------------------------------------------------
echo
step "Backing up data/"
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || warn "WAL checkpoint failed - backing up anyway"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/threepl-before-reset-$STAMP.tgz"
tar czf "$BACKUP" -C "$APP_DIR" data
chown "$APP_USER:$APP_USER" "$BACKUP" 2>/dev/null || true
ok "$BACKUP ($(du -h "$BACKUP" | cut -f1))"

# ---- stop, wipe, restart ---------------------------------------------------
echo
step "Stopping $SERVICE_NAME"
WAS_ACTIVE=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo inactive)
systemctl stop "$SERVICE_NAME" 2>/dev/null || warn "Service was not running"

step "Clearing tables"
# Children before parents so the foreign keys stay satisfied throughout.
sqlite3 "$DB" <<'SQL'
PRAGMA foreign_keys = ON;
BEGIN;
DELETE FROM po_events;
DELETE FROM po_items;
DELETE FROM purchase_orders;
DELETE FROM shipping_labels;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM notifications;
DELETE FROM client_rates;
DELETE FROM users WHERE role <> 'admin';
-- restart ids (and therefore invoice numbers) from the beginning
DELETE FROM sqlite_sequence
 WHERE name IN ('orders','order_items','shipping_labels','purchase_orders',
                'po_items','po_events','notifications');
COMMIT;
VACUUM;
SQL
ok "Tables cleared"

step "Removing uploaded files"
for d in invoices fnsku payments shiplabels po-photos; do
  target="$APP_DIR/data/$d"
  [ -d "$target" ] || continue
  find "$target" -mindepth 1 -maxdepth 1 -type f -delete
  info "$d emptied"
done
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

if [ "$WAS_ACTIVE" = "active" ]; then
  step "Restarting $SERVICE_NAME"
  systemctl start "$SERVICE_NAME"
  sleep 2
  info "Service is $(systemctl is-active "$SERVICE_NAME")"
fi

# ---- report ----------------------------------------------------------------
echo
step "Result"
printf "    %-26s %s\n" "users (admin only)" "$(count users)"
for t in orders order_items purchase_orders po_items po_events notifications; do
  printf "    %-26s %s\n" "$t" "$(count $t)"
done
printf "    %-26s %s\n" "settings (kept)" "$(count settings)"
sqlite3 "$DB" "SELECT '      '||key||' = '||value FROM settings WHERE key LIKE 'rate_%' OR key LIKE 'discount_t%' ORDER BY key;"
echo
echo "=============================="
echo " ${G}Reset complete${N}"
echo " Admin login is unchanged."
echo " Backup : $BACKUP"
echo " Restore: sudo systemctl stop $SERVICE_NAME && \\"
echo "            tar xzf $BACKUP -C $APP_DIR && \\"
echo "            sudo systemctl start $SERVICE_NAME"
echo "=============================="
