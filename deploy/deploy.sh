#!/usr/bin/env bash
# Run only on the self-hosted Ubuntu server; the registry token arrives on stdin.
set -euo pipefail
umask 077
incoming=${1:?Missing incoming directory}
[[ $incoming =~ ^/tmp/scenesparrow-deploy\.[A-Za-z0-9]+$ ]] || exit 2
cleanup() {
  [[ -z ${registry_config:-} ]] || rm -rf -- "$registry_config"
  rm -rf -- "$incoming"
}
trap cleanup EXIT

mapfile -t config < <(python3 - "$incoming/config.json" <<'PY'
import json, re, sys
from urllib.parse import urlsplit
c = json.load(open(sys.argv[1]))
assert set(c) == {'image', 'origin', 'directory', 'port', 'actor'}
assert re.fullmatch(r'ghcr\.io/[a-z0-9][a-z0-9_./-]*@sha256:[a-f0-9]{64}', c['image'])
assert re.fullmatch(r'/[A-Za-z0-9_/-]+', c['directory']) and '..' not in c['directory'].split('/')
assert c['directory'] not in ('/', '/tmp', '/home', '/srv', '/opt', '/var')
u = urlsplit(c['origin'])
assert u.scheme == 'https' and u.hostname and not u.username and not u.password
assert c['origin'] == 'https://' + u.netloc and re.fullmatch(r'https://[A-Za-z0-9.:-]+', c['origin'])
assert isinstance(c['port'], int) and 1024 <= c['port'] <= 65535
assert re.fullmatch(r'[A-Za-z0-9_-]+', c['actor'])
print(c['image'], c['origin'], c['directory'], c['port'], c['actor'], sep='\n')
PY
)
[[ ${#config[@]} == 5 ]] || { echo 'Invalid deployment configuration' >&2; exit 2; }
image=${config[0]}
origin=${config[1]}
directory=${config[2]}
port=${config[3]}
actor=${config[4]}
mkdir -p -- "$directory"
exec 9>"$directory/deploy.lock"
flock -x 9
mkdir -p -- "$directory/secrets" "$directory/backups"
chmod 700 "$directory/secrets" "$directory/backups"
auth_file=$directory/secrets/operator-auth
master_file=$directory/secrets/ai-master-key
[[ -f $auth_file || -f $incoming/operator-auth ]] || { echo 'Provision operator-auth first' >&2; exit 2; }
next_auth=$auth_file
[[ ! -f $incoming/operator-auth ]] || next_auth=$incoming/operator-auth
# Validate both provisioned and rotated secrets without exposing their contents.
python3 - "$next_auth" <<'PYAUTH'
import re, sys
s = open(sys.argv[1]).read().removesuffix('\n')
assert re.fullmatch(r'[A-Za-z0-9_-]{1,64}:[!-~]{6,256}', s), 'Invalid operator configuration'
PYAUTH
validate_master_key() {
  python3 - "$master_file" <<'PYKEY'
import base64, os, stat, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        assert stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022 and info.st_size <= 128
        encoded = f.read(129).strip()
        key = base64.b64decode(encoded, validate=True)
        assert len(key) == 32 and base64.b64encode(key) == encoded
except Exception:
    sys.exit('Invalid AI master key configuration; restore the original key file.')
PYKEY
}
if [[ -e $master_file || -L $master_file ]]; then validate_master_key; fi
printf 'SCENESPARROW_IMAGE=%s\nPUBLIC_ORIGIN=%s\nWEB_PORT=%s\nOPERATOR_AUTH_FILE=%s\nAI_MASTER_KEY_FILE=%s\n' \
  "$image" "$origin" "$port" "$next_auth" "$master_file" > "$incoming/runtime.env"
docker compose --env-file "$incoming/runtime.env" -f "$incoming/compose.yaml" config --quiet
registry_config=$(mktemp -d /tmp/scenesparrow-registry.XXXXXXXX)
export DOCKER_CONFIG=$registry_config
docker login ghcr.io --username "$actor" --password-stdin > /dev/null
docker compose --env-file "$incoming/runtime.env" -f "$incoming/compose.yaml" pull --quiet
rm -rf -- "$registry_config"
unset DOCKER_CONFIG
registry_config=

# Inspect only an already-existing volume, so checking a first deployment never
# creates data. A header-only vault is encrypted data; an empty/lock-only folder
# can be left by interrupted initialization. Unknown contents fail closed.
if [[ ! -e $master_file && ! -L $master_file ]]; then
  existing_appdata=$(docker volume ls --filter 'name=^scenesparrow-appdata$' --format '{{.Name}}') || {
    echo 'Cannot inspect app-data volumes; master key was not generated.' >&2
    exit 1
  }
  [[ -z $existing_appdata || $existing_appdata == scenesparrow-appdata ]] || {
    echo 'Unexpected app-data volume inventory; master key was not generated.' >&2
    exit 1
  }
  if [[ $existing_appdata == scenesparrow-appdata ]]; then
    if ! docker run --rm --user 0 --entrypoint node \
      --mount 'type=volume,src=scenesparrow-appdata,dst=/source,readonly' \
      "$image" -e 'const fs=require("node:fs"); const p="/source/credentials-v1"; try { const s=fs.lstatSync(p); if(!s.isDirectory() || s.isSymbolicLink() || fs.readdirSync(p).some(n=>n!==".lock")) process.exit(42); } catch(e) { if(e.code!=="ENOENT") process.exit(43); }'; then
      echo 'AI vault exists or cannot be inspected. Restore its original master key before deployment.' >&2
      exit 1
    fi
  fi
  python3 - "$master_file" <<'PYCREATE'
import base64, os, secrets, sys
try:
    fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    with os.fdopen(fd, 'wb') as f:
        f.write(base64.b64encode(secrets.token_bytes(32)) + b'\n')
        os.fchmod(f.fileno(), 0o444)
        f.flush()
        os.fsync(f.fileno())
    parent = os.open(os.path.dirname(sys.argv[1]), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
except Exception:
    sys.exit('Cannot provision AI master key; inspect the protected host secrets directory.')
PYCREATE
fi
validate_master_key

# Stop with the currently active definition before copying every byte of both volumes.
# A failed backup leaves the old service stopped; it never starts a migration without a backup.
if [[ -f $directory/compose.yaml && -f $directory/runtime.env ]]; then
  docker compose --env-file "$directory/runtime.env" -f "$directory/compose.yaml" stop --timeout 60
fi
for volume in scenesparrow-project scenesparrow-appdata; do
  if [[ -n $(docker ps -q --filter "volume=$volume") ]]; then
    echo 'A running container still mounts persistent data; stop its owner before deploying.' >&2
    exit 1
  fi
done
backup=$(mktemp -d "$directory/backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
for name in compose.yaml runtime.env; do
  [[ ! -f $directory/$name ]] || cp -- "$directory/$name" "$backup/$name"
done
for volume in scenesparrow-project scenesparrow-appdata; do
  if docker volume inspect "$volume" > /dev/null 2>&1; then
    docker run --rm --user 0 --entrypoint tar \
      --mount "type=volume,src=$volume,dst=/source,readonly" \
      --mount "type=bind,src=$backup,dst=/backup" \
      "$image" -czf "/backup/$volume.tar.gz" -C /source .
  fi
done
printf '%s\n' "$image" > "$backup/requested-image"
if [[ -f $incoming/operator-auth ]]; then install -m 0444 "$incoming/operator-auth" "$auth_file"; fi
printf 'SCENESPARROW_IMAGE=%s\nPUBLIC_ORIGIN=%s\nWEB_PORT=%s\nOPERATOR_AUTH_FILE=%s\nAI_MASTER_KEY_FILE=%s\n' \
  "$image" "$origin" "$port" "$auth_file" "$master_file" > "$incoming/runtime.env"
install -m 0600 "$incoming/compose.yaml" "$directory/compose.yaml"
install -m 0600 "$incoming/runtime.env" "$directory/runtime.env"
if ! docker compose --env-file "$directory/runtime.env" -f "$directory/compose.yaml" up -d --force-recreate --pull never --wait --wait-timeout 120; then
  echo "Deployment failed. Backup retained at $backup; inspect the service before manual recovery. No database restore or image rollback was attempted." >&2
  exit 1
fi
printf 'Deployment ready. Offline backup: %s\n' "$backup"
