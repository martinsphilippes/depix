#!/usr/bin/env bash
# Prepara um projeto Firebase real: índices, regras e dados de referência.
#
# Roda uma vez, depois de criar o banco no console. Idempotente — repetir não
# estraga nada.
#
#   FIREBASE_PROJECT_ID=seu-projeto \
#   GOOGLE_APPLICATION_CREDENTIALS=/caminho/chave.json \
#   ./scripts/preparar-firebase.sh
set -uo pipefail
cd "$(dirname "$0")/.."

: "${FIREBASE_PROJECT_ID:?defina FIREBASE_PROJECT_ID}"
: "${GOOGLE_APPLICATION_CREDENTIALS:?defina GOOGLE_APPLICATION_CREDENTIALS com o caminho da chave}"

# Escrever num projeto real fora de produção exige intenção explícita — é o
# mesmo gate do §34, e aqui a intenção é justamente esta.
export ALLOW_REAL_FIRESTORE=yes

echo "projeto: $FIREBASE_PROJECT_ID"
echo

echo "→ 1/3 conferindo se o banco existe"
# A saída de erro é mostrada, não descartada: a mensagem de orientação é
# justamente o que este passo tem de útil quando falha.
if ! node --experimental-strip-types -e "
  const { createDb, createFirestore } = await import('@depix/firestore');
  const db = createDb(createFirestore({ projectId: process.env.FIREBASE_PROJECT_ID }));
  try { await db.collection('assets').limit(1).get(); }
  catch (e) {
    if (String(e.message).includes('has not been used in project')) {
      console.error('\n   O banco Firestore ainda não foi criado neste projeto.');
      console.error('   Abra o console, clique em Criar banco de dados, escolha');
      console.error('   modo produção e a região southamerica-east1:');
      console.error('   https://console.firebase.google.com/project/' + process.env.FIREBASE_PROJECT_ID + '/firestore');
      process.exit(2);
    }
    throw e;
  } finally { await db.close(); }
"; then
  exit 2
fi
echo "   ok"

echo "→ 2/3 dados de referência (ativos, contas de sistema, providers)"
node --experimental-strip-types packages/firestore/src/cli.ts || exit 1

echo
echo "→ 3/3 publicando regras e índices"
# Pela API REST, e não por `firebase deploy`: o CLI consulta o Service Usage
# antes de publicar, e essa permissão não vem na chave do Firebase. O erro
# resultante fala de `serviceusage` e despista.
#
# Este passo vem por último de propósito. Ele é o único que pode exigir uma
# permissão a mais, e falhar aqui não desfaz nada do que já foi feito: os
# dados de referência já estão gravados e o script pode ser repetido.
if ! node --experimental-strip-types scripts/publicar-firestore.mjs; then
  echo
  echo "Os dados de referência já foram gravados. Falta só o passo acima —"
  echo "resolva a permissão e rode este mesmo comando de novo."
  exit 1
fi

echo
echo "pronto. Confira em https://SEU-DOMINIO/api/health"
echo "Para dar acesso ao painel: npm run bootstrap -- admin <userId> operator"
