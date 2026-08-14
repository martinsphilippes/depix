#!/usr/bin/env bash
# Sobe emulador, API e interface para uma demonstração local, e segura o
# processo até ser interrompido.
#
# Não é para produção: as chaves são geradas na hora e o banco é o emulador,
# que perde tudo ao ser derrubado. Serve para ver o sistema funcionando.
set -uo pipefail
cd "$(dirname "$0")/.."

export FIREBASE_PROJECT_ID=demo-depix-dev
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export IP_HASH_SALT=demo-salt
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_RP_NAME=Carteira
export WEBAUTHN_ORIGIN=${WEBAUTHN_ORIGIN:-http://localhost:3996}
export APP_ENV=development
export PORT=3001
export LOG_LEVEL=warn
export ENCRYPTION_KEY=${ENCRYPTION_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")}

WEB_PORT=${WEB_PORT:-3996}

encerrar() {
  echo "encerrando…"
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap encerrar INT TERM

echo "→ emulador do Firestore"
npx firebase emulators:start --only firestore --project "$FIREBASE_PROJECT_ID" > /tmp/demo-emulador.log 2>&1 &

for _ in $(seq 1 60); do
  grep -q "All emulators ready" /tmp/demo-emulador.log 2>/dev/null && break
  sleep 1
done

echo "→ dados de referência"
node --experimental-strip-types packages/firestore/src/cli.ts > /tmp/demo-bootstrap.log 2>&1

echo "→ API"
node --experimental-strip-types apps/api/src/main.ts > /tmp/demo-api.log 2>&1 &

echo "→ worker (confirmações e conciliação)"
node --experimental-strip-types apps/api/src/worker.ts > /tmp/demo-worker.log 2>&1 &

echo "→ interface"
(cd apps/web && npx next start -p "$WEB_PORT" > /tmp/demo-web.log 2>&1) &

for _ in $(seq 1 40); do
  curl -sf "http://localhost:${WEB_PORT}/" > /dev/null 2>&1 && break
  sleep 1
done

echo
echo "no ar:"
echo "  interface  http://localhost:${WEB_PORT}"
echo "  API        http://localhost:3001/health"
echo "  emulador   http://localhost:4000"
echo
echo "Ctrl-C encerra."

wait
