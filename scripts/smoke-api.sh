#!/usr/bin/env bash
# Teste de fumaça: sobe a API de verdade e bate nas rotas por HTTP.
# Os testes da suíte usam `app.inject`, que pula o servidor — isto não.
set -uo pipefail

export FIREBASE_PROJECT_ID=demo-depix-dev
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export IP_HASH_SALT=smoke-salt
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_ORIGIN=http://localhost:3000
export APP_ENV=development
export PORT=3999
export LOG_LEVEL=error
# A API recusa subir sem esta chave — comportamento correto, verificado ao
# escrever este script: a primeira execução falhou exatamente aqui.
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export ENCRYPTION_KEY

node --experimental-strip-types packages/firestore/src/cli.ts >/dev/null 2>&1 || echo "BOOTSTRAP FALHOU"

node --experimental-strip-types apps/api/src/main.ts >/tmp/api.log 2>&1 &
API=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "=== health";      curl -s "http://127.0.0.1:${PORT}/health"
echo; echo "=== lightning";   curl -s "http://127.0.0.1:${PORT}/lightning/status" | head -c 140
echo; echo "=== sem sessao (espera 401)"; curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/contacts"
echo; echo "=== cors";        curl -s -o /dev/null -D- -X OPTIONS \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: GET' \
  "http://127.0.0.1:${PORT}/wallet/balance" | grep -i 'access-control-allow' || echo "SEM CORS"
echo "=== passkey start";  curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  "http://127.0.0.1:${PORT}/auth/register/start" | head -c 200
echo; echo "=== log do servidor"; tail -5 /tmp/api.log

kill "$API" 2>/dev/null
wait "$API" 2>/dev/null
exit 0
