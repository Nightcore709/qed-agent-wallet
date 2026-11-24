#!/bin/sh
# The container's entry (apps/qed-demo/Dockerfile; docs/DEPLOY.md, "Processes"; docs/LEAST-PRIVILEGE.md).
#
# 1. As root, given QED_KEK: the key goes to a private file (mode 600, folder 700) and this script replaces itself (exec)
#    with an environment that names the file (QED_KEY_FILE) and no longer holds the key. Every process after it starts
#    without the key in its environment, process 1 included (R13 review fix F3: deleting a variable does not remove it
#    from /proc/<pid>/environ, which processes of the same user can read).
# 2. As process 1: exec tini, which runs this script again as its child and reaps the processes under it.
# 3. As root under tini: the volume and the private secrets folder are given to the service's user ("node"); the
#    co-signer's own folder on the volume (its nonces and revocations) to the co-signer's user ("qedcosign"), which may
#    pass through the data folder (711) but read nothing of the service's. A state file from an earlier image is moved
#    there once. Then the supervisor runs as "node" with no capability but CAP_SETUID and CAP_SETGID (ambient; the
#    bounding set reduced to those two; no way to gain privileges): the wallet service needs them to start the co-signer
#    as "qedcosign" (chain/rail/cosigner-env.ts); every other child is started without them (chain/rail/caps.ts).
# Started as another user already (RAILWAY_RUN_UID), it just runs the supervisor (which hands QED_KEK off itself, and
# the co-signer then runs as that same user: there is no second user to switch to).
set -eu
data="${QED_DATA_DIR:-/data}"
secrets="${QED_SECRETS_DIR:-/run/qed}"
supervisor=/app/apps/qed-demo/scripts/deploy/supervise.ts
# Root follows no link the service's user could have left in a folder it owns (independent review of the fixes, M1, 25 Nov
# 2026): the private secrets folder is made anew on every start, the key is written only into that new folder, and a
# link anywhere root writes or changes a mode or an owner stops the start.
refuse_link() { for p in "$@"; do if [ -L "$p" ]; then echo "entrypoint: $p is a symbolic link; not starting" >&2; exit 2; fi; done; }
if [ "$(id -u)" = 0 ]; then
  case "$secrets" in /run/?*) ;; *) echo "entrypoint: QED_SECRETS_DIR must be a folder under /run" >&2; exit 2 ;; esac
  if [ -n "${QED_KEK:-}" ]; then
    if [ -n "${QED_KEY_FILE:-}" ]; then echo "entrypoint: both QED_KEK and QED_KEY_FILE are set; set one" >&2; exit 2; fi
    rm -rf "$secrets"
    mkdir -m 700 "$secrets"
    (umask 077 && set -C && printf '%s\n' "$QED_KEK" > "$secrets/qed.kek")
    exec env -u QED_KEK QED_KEY_FILE="$secrets/qed.kek" "$0" "$@"
  fi
  if [ "$$" = 1 ]; then exec /usr/bin/tini -- "$0" "$@"; fi
  cosigner_dir="$data/cosigner"
  refuse_link "$data" "$secrets" "$secrets/qed.kek" "$cosigner_dir" "$cosigner_dir/cosigner-state.json"
  mkdir -p "$data" "$secrets"
  # once, on a volume that is not yet the service's (a fresh one, or one written by a root process): then never again;
  # chown -R without -H or -L changes a link found inside, never what it points to
  if [ "$(stat -c %U "$data")" != node ]; then chown -R node:node "$data"; fi
  chown -h node:node "$secrets"
  chmod 700 "$secrets"
  if [ -f "$secrets/qed.kek" ]; then chown -h node:node "$secrets/qed.kek"; chmod 600 "$secrets/qed.kek"; fi
  mkdir -p "$cosigner_dir"
  if [ ! -e "$cosigner_dir/cosigner-state.json" ] && [ -f "$data/app/rail/cosigner-state.json" ] && [ ! -L "$data/app/rail/cosigner-state.json" ]; then
    mv "$data/app/rail/cosigner-state.json" "$cosigner_dir/cosigner-state.json"
  fi
  chown -R qedcosign:qedcosign "$cosigner_dir"
  chmod 700 "$cosigner_dir"
  chmod 711 "$data"
  QED_COSIGNER_UID=$(id -u qedcosign)
  QED_COSIGNER_GID=$(id -g qedcosign)
  QED_COSIGNER_STATE_DIR="$cosigner_dir"
  export QED_COSIGNER_UID QED_COSIGNER_GID QED_COSIGNER_STATE_DIR
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all,+setuid,+setgid --ambient-caps=+setuid,+setgid \
    --bounding-set=-all,+setuid,+setgid --no-new-privs node "$supervisor" "$@"
fi
exec node "$supervisor" "$@"
