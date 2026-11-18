#!/bin/bash
# Scratch end-to-end test of the real lookstow launcher on Linux, no root
# (SPEC-INSTALL-AND-UPDATES SU12): install --no-service, run, update A->B
# healthy, a release signed by another key refused, B->C broken but declared
# compatible (rolled back), B->D broken and not compatible (stopped with
# instructions), update --recover, uninstall and --purge. Node is a shell
# stand-in that writes ready.json the way the app does.
#
# Usage: scratch-update-test.sh <lookstow> <key.pem>
#   <lookstow>  built with --features scratch-test and
#               LOOKSTOW_EXTRA_RELEASE_KEY set to <key.pem>'s public key
#   <key.pem>   an Ed25519 private key (openssl genpkey -algorithm ed25519),
#               never the release key
# Needs OpenSSL 3 (pkeyutl -rawin), GNU tar, coreutils.
set -eu
[ $# -eq 2 ] || { echo "usage: $0 <lookstow> <key.pem>" >&2; exit 2; }
BIN=$(realpath "$1")
T=x86_64-unknown-linux-gnu
R=$(mktemp -d /tmp/lookstow-scratch.XXXXXX)
trap '[ -f "$R/run.pid" ] && kill "$(cat "$R/run.pid")" 2>/dev/null; rm -rf "$R"' EXIT
mkdir -p "$R/src" "$R/bundles"
cp "$2" "$R/key.pem"
openssl genpkey -algorithm ed25519 -out "$R/other.pem" 2>/dev/null

# A stand-in for Node: reports ready like the app does (ready.json with the
# launcher's nonce and the release version), unless the release is broken.
make_bundle() { # version broken
  local d="$R/bundles/$1"
  mkdir -p "$d/node/bin" "$d/app/build"
  cp "$BIN" "$d/lookstow"; chmod 755 "$d/lookstow"
  echo "$1" > "$d/VERSION"; echo "AGPL" > "$d/LICENSE"
  echo '// server' > "$d/app/server.js"
  printf '{"name":"lookstow","version":"%s","type":"module"}\n' "$1" > "$d/app/package.json"
  cat > "$d/node/bin/node" <<EOF
#!/bin/sh
echo "node \$* cwd=\$(pwd) db=\$DATABASE_PATH deployment=\$LOOKSTOW_DEPLOYMENT target=\$LOOKSTOW_LAUNCHER_TARGET" >> "\$LOOKSTOW_UPDATE_DATA/node.log"
if [ "$2" = broken ]; then exit 1; fi
printf '{"nonce":"%s","version":"%s"}' "\$LOOKSTOW_READINESS_NONCE" "$1" > "\$LOOKSTOW_UPDATE_DATA/ready.json.tmp"
mv "\$LOOKSTOW_UPDATE_DATA/ready.json.tmp" "\$LOOKSTOW_UPDATE_DATA/ready.json"
trap 'exit 0' TERM
while true; do sleep 1; done
EOF
  chmod 755 "$d/node/bin/node"
}

# A signed release in the folder source: archive plus manifest.
publish() { # version rollbackFrom-json key
  local v=$1 d="$R/src/v$1"
  mkdir -p "$d"
  tar -C "$R/bundles/$v" -czf "$d/lookstow-app-$T.tar.gz" lookstow node app VERSION LICENSE
  local bytes sha
  bytes=$(stat -c %s "$d/lookstow-app-$T.tar.gz")
  sha=$(sha256sum "$d/lookstow-app-$T.tar.gz" | cut -d' ' -f1)
  printf '{"schemaVersion":1,"version":"%s","target":"%s","archive":"lookstow-app-%s.tar.gz","bytes":%s,"sha256":"%s","minimumLauncher":"1.0.0","nodeMajor":26,"rollbackFrom":%s}' \
    "$v" "$T" "$T" "$bytes" "$sha" "$2" > "$d/payload.json"
  { printf 'LOOKSTOW-SERVER-UPDATE-1\n'; cat "$d/payload.json"; } > "$d/message"
  openssl pkeyutl -sign -inkey "$3" -rawin -in "$d/message" -out "$d/signature"
  printf '{"payload":"%s","signature":"%s"}' "$(base64 -w0 "$d/payload.json")" "$(base64 -w0 "$d/signature")" > "$d/lookstow-app-$T.json"
  echo "$v" > "$R/src/latest"
}

# The "service": the installed launcher's run, in the background.
cat > "$R/service.sh" <<EOF
#!/bin/sh
case "\$1" in
  start) nohup "$R/opt/current/lookstow" run --data-dir "$R/data" >> "$R/run.log" 2>&1 &
         echo \$! > "$R/run.pid" ;;
  stop)  if [ -f "$R/run.pid" ]; then kill "\$(cat $R/run.pid)" 2>/dev/null || true
           while kill -0 "\$(cat $R/run.pid)" 2>/dev/null; do sleep 0.2; done; rm -f "$R/run.pid"; fi ;;
esac
EOF
chmod 755 "$R/service.sh"
export LOOKSTOW_UPDATE_TEST_SOURCE="$R/src" LOOKSTOW_UPDATE_TEST_SERVICE="$R/service.sh" LOOKSTOW_UPDATE_TEST_HEALTH_SECONDS=8
F="--prefix $R/opt --data-dir $R/data"
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; exit 1; fi; }

for v in 1.0.0 1.1.0; do make_bundle $v ok; done
make_bundle 1.2.0 broken; make_bundle 1.3.0 broken; make_bundle 1.4.0 ok

echo "== install 1.0.0"
"$R/bundles/1.0.0/lookstow" install $F --no-service --port 47620
check "current is 1.0.0" '[ "$(readlink $R/opt/current)" = releases/1.0.0 ]'
check "server.env has a key, 127.0.0.1 and the port" 'grep -q "^SECRETS_KEY=" $R/data/server.env && grep -q "^HOST=127.0.0.1$" $R/data/server.env && grep -q "^PORT=47620$" $R/data/server.env'
check "data 0700, server.env 0600" '[ "$(stat -c %a $R/data)" = 700 ] && [ "$(stat -c %a $R/data/server.env)" = 600 ]'
KEY1=$(grep SECRETS_KEY "$R/data/server.env")
"$R/opt/current/lookstow" status $F
check "--version" '"$R/opt/current/lookstow" --version | grep -q "^lookstow [0-9]"'

echo "== re-install keeps settings"
"$R/bundles/1.0.0/lookstow" install $F --no-service --port 9999 | grep -q "keeps port 47620"
check "secrets key kept" '[ "$(grep SECRETS_KEY $R/data/server.env)" = "$KEY1" ]'

echo "== run starts node with the right command"
"$R/service.sh" start
for i in $(seq 1 40); do [ -f "$R/data/ready.json" ] && break; sleep 0.25; done
check "ready.json written" '[ -f $R/data/ready.json ]'
check "node got env file, entry, cwd and database" 'grep -q "node --env-file=$R/data/server.env $R/opt/releases/1.0.0/app/server.js cwd=$R/opt/releases/1.0.0/app db=$R/data/lookstow.db deployment=installed target=$T" $R/data/node.log'
echo "database" > "$R/data/lookstow.db"

echo "== no flag: nothing to do"
"$R/opt/current/lookstow" update $F | grep -q NothingToDo

echo "== 1.1.0 healthy"
publish 1.1.0 '["1.0.0"]' "$R/key.pem"
touch "$R/data/update-requested"
"$R/opt/current/lookstow" update $F
check "current is 1.1.0" '[ "$(readlink $R/opt/current)" = releases/1.1.0 ]'
check "status healthy" 'grep -q "\"phase\":\"healthy\"" $R/data/update-status.json'
check "flag gone" '[ ! -e $R/data/update-requested ]'
check "database copy" '[ "$(cat $R/data/backups/pre-update-1.0.0-to-1.1.0.db)" = database ]'
check "1.0.0 kept" '[ -d $R/opt/releases/1.0.0 ]'

echo "== another key: refused"
publish 1.4.0 '[]' "$R/other.pem"
touch "$R/data/update-requested"
"$R/opt/current/lookstow" update $F || true
check "still 1.1.0" '[ "$(readlink $R/opt/current)" = releases/1.1.0 ]'
check "status failed, not trusted" 'grep -q "not from a trusted release key" $R/data/update-status.json'
rm -rf "$R/src/v1.4.0"

echo "== 1.2.0 broken, declares 1.1.0: rolled back"
publish 1.2.0 '["1.1.0"]' "$R/key.pem"
touch "$R/data/update-requested"
"$R/opt/current/lookstow" update $F
check "back on 1.1.0" '[ "$(readlink $R/opt/current)" = releases/1.1.0 ]'
check "status rolled-back" 'grep -q "\"phase\":\"rolled-back\"" $R/data/update-status.json'
sleep 1
check "1.1.0 runs again" '[ -f $R/run.pid ] && kill -0 $(cat $R/run.pid)'

echo "== 1.3.0 broken, no rollback: stopped with instructions"
publish 1.3.0 '[]' "$R/key.pem"
touch "$R/data/update-requested"
"$R/opt/current/lookstow" update $F || true
check "stays on 1.3.0" '[ "$(readlink $R/opt/current)" = releases/1.3.0 ]'
check "instructions name the copy" 'grep -q "pre-update-1.1.0-to-1.3.0.db" $R/data/update-status.json'
check "service stopped" '[ ! -f $R/run.pid ]'

echo "== interrupted rollback finished by --recover"
"$R/bundles/1.0.0/lookstow" install $F --no-service >/dev/null
printf '{"from":"1.0.0","to":"1.1.0","step":"rolling-back","nonce":"%s","rollbackCompatible":true}' "$(printf 'b%.0s' $(seq 64))" > "$R/opt/update-switch.json"
"$R/opt/current/lookstow" update --recover $F
check "recover leaves 1.0.0 and no record" '[ "$(readlink $R/opt/current)" = releases/1.0.0 ] && [ ! -e $R/opt/update-switch.json ]'

echo "== uninstall"
"$R/opt/current/lookstow" uninstall $F
check "program gone, data kept" '[ ! -e $R/opt ] && [ -f $R/data/server.env ]'
"$R/bundles/1.0.0/lookstow" uninstall $F --purge
check "data gone" '[ ! -e $R/data ]'
echo "ALL PASSED"
