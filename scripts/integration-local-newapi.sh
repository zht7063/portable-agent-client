#!/usr/bin/env bash
# M3 local integration: official new-api release binary (e.g. v1.0.0-rc.46) + throwaway sqlite DB + fake account,
# then the live proxy test and the Electron login smoke (xvfb). Everything is deleted afterwards.
# Run inside a loopback-only network namespace so nothing listens beyond localhost:
#   NEWAPI_BIN=/path/new-api-v1.0.0-rc.46 unshare -rn scripts/integration-local-newapi.sh
# (Docker equivalent: calciumion/new-api:<tag> bound to 127.0.0.1 — docker was not available on the dev box.)
set -euo pipefail
ip link set lo up 2>/dev/null || true
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${NEWAPI_BIN:?set NEWAPI_BIN to the official new-api release binary (checksum-verified)}"
W=$(mktemp -d /tmp/m3-integ.XXXXXX); echo "workdir $W"
export HOME="$W/home"; mkdir -p "$HOME"
mkdir -p "$W/data" "$W/logs"
PORT=${PORT:-3917}
( cd "$W/data" && exec env SQL_DSN= SESSION_SECRET="$(head -c 24 /dev/urandom | base64)" PORT=$PORT "$NEWAPI_BIN" --log-dir "$W/logs" >"$W/server.log" 2>&1 ) &
SPID=$!
trap 'kill $SPID 2>/dev/null; rm -rf "$W"' EXIT
for i in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null && break; sleep 0.5; done
curl -s "http://127.0.0.1:$PORT/api/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("server version",j.data.version)})'
# Fake test account (local throwaway container-equivalent only); password random, kept in a file, never printed.
head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$W/pass"; chmod 600 "$W/pass"
node -e 'const fs=require("fs");const p=fs.readFileSync(process.argv[1],"utf8");fetch(process.argv[2],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"pacsmoke",password:p,confirmPassword:p,SelfUseModeEnabled:true,DemoSiteEnabled:false})}).then(r=>r.json()).then(j=>console.log("setup",j.success,j.message||""))' "$W/pass" "http://127.0.0.1:$PORT/api/setup"
cd "$ROOT"
set +e
PAC_LIVE_PROXY=1 PAC_SERVER_URL="http://127.0.0.1:$PORT" PAC_LIVE_USER=pacsmoke PAC_LIVE_PASS_FILE="$W/pass" PAC_LIVE_KEY_OUT="$W/key" npx vitest run -c vitest.live.config.ts test/live/proxy.live.test.ts 2>&1 | tail -15
LIVE=${PIPESTATUS[0]}
cd apps/desktop
PAC_SERVER_URL="http://127.0.0.1:$PORT" PA_SMOKE_LOGIN=1 PA_SMOKE_USER=pacsmoke PA_SMOKE_PASS_FILE="$W/pass" PA_SMOKE_SECRET_FILE="$W/key" \
  PA_SMOKE_SCREENSHOT="${PA_SMOKE_SCREENSHOT:-/tmp/m3-smoke.png}" PA_SMOKE_WAIT_MS=3000 xvfb-run -a -s "-screen 0 1400x900x24" node scripts/smoke.mjs 2>&1 | tail -3
SMOKE=${PIPESTATUS[0]}
kill $SPID; wait $SPID 2>/dev/null
rm -rf "$W"; echo "cleaned $W"
echo "LIVE=$LIVE SMOKE=$SMOKE"
exit $(( LIVE != 0 || SMOKE != 0 ))
