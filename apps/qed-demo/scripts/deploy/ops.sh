#!/bin/sh
# Operator commands inside the running container (docs/DEPLOY.md, "Operating it"), e.g. after `railway ssh --service qed`:
#   /app/apps/qed-demo/scripts/deploy/ops.sh <command>
#     status            the engine, data sources and latest prices          verify          every ledger and receipt chain
#     backup            a sealed backup of the database, now                backup-verify   every sealed set, decrypted and checked
#     drill             restore the newest backup into a scratch folder and verify it there
#     backups           the sealed backups and wallet-service archives      copies          the sealed pre-migration copies
#     maintenance-on    stop the services (the port answers 503)            maintenance-off start them again
#     offsite-check     validate the off-host and retention settings        offsite-push    copy sealed backups off the volume now
#     offsite-list      what the off-host store holds                       offsite-drill   restore the newest off-host copy into scratch and verify
#     rewrap            re-wrap the keyrings under QED_NEW_KEK (section 19)
#     prune             apply retention now (QED_BACKUP_RETENTION=on)       revoke-sessions sign everyone out (see docs/DEPLOY.md, secret rotation)
# Same paths and keys as the services (scripts/deploy/supervise.ts), run as the service's user so that nothing on the
# volume becomes root's. Prints no key.
set -eu
data="${QED_DATA_DIR:-/data}"
export QED_DB="${QED_DB:-$data/app/qed.db}" QED_RAIL_DATA="${QED_RAIL_DATA:-$data/app}" QED_KEY_DIR="${QED_KEY_DIR:-$data/keys}" QED_BACKUP_DIR="${QED_BACKUP_DIR:-$data/backups}"
export QED_KEY_FILE="${QED_KEY_FILE:-${QED_SECRETS_DIR:-/run/qed}/qed.kek}"
unset QED_KEK
as_service() { if [ "$(id -u)" = 0 ]; then setpriv --reuid=node --regid=node --init-groups "$@"; else "$@"; fi; }
cd "$(dirname "$0")/../.."
case "${1:-}" in
  status) as_service node server/main.ts status ;;
  verify) as_service node server/main.ts verify ;;
  backup) as_service node scripts/backup.ts create ;;
  backup-verify) as_service node scripts/backup.ts verify ;;
  drill) as_service node scripts/backup.ts drill ;;
  backups) ls -l "$QED_BACKUP_DIR" "$QED_BACKUP_DIR/wallet-service" 2>/dev/null ;;
  copies) ls -l "$(dirname "$QED_DB")/migration-copies" 2>/dev/null ;;
  maintenance-on) as_service touch "$data/MAINTENANCE"; echo "services stop within a few seconds; the port answers 503 until maintenance-off" ;;
  offsite-check) as_service node scripts/backup-offsite.ts check ;;
  offsite-push) as_service node scripts/backup-offsite.ts push ;;
  offsite-list) as_service node scripts/backup-offsite.ts list ;;
  offsite-drill) as_service node scripts/backup-offsite.ts drill ;;
  prune) as_service node scripts/backup-offsite.ts prune ;;
  revoke-sessions) as_service node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const d = new DatabaseSync(process.env.QED_DB); d.exec('PRAGMA busy_timeout=10000'); const r = d.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now()); console.log('sessions revoked: ' + r.changes); d.close()" ;;
  rewrap) # re-wrap every keyring under a NEW key-encryption key record read from the environment variable QED_NEW_KEK
    [ -n "${QED_NEW_KEK:-}" ] || { echo "set QED_NEW_KEK to the new record first (docs/DEPLOY.md section 19: stty -echo; IFS= read -r QED_NEW_KEK; stty echo; export QED_NEW_KEK)"; exit 2; }
    as_service node scripts/backup.ts rewrap --new-key-env QED_NEW_KEK; unset QED_NEW_KEK ;;
  maintenance-off) rm -f "$data/MAINTENANCE"; echo "services start within a few seconds" ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
