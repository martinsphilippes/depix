/**
 * Publica regras e índices do Firestore pela API REST.
 *
 * Existe porque `firebase deploy --only firestore` falha com a conta de
 * serviço padrão do Firebase: antes de publicar, o CLI **consulta** o Service
 * Usage para ver se a API do Firestore está ativa, e `serviceusage.services.get`
 * não faz parte dos papéis do `firebase-adminsdk`. O erro que aparece fala de
 * `serviceusage`, o que faz parecer problema de Firestore quando não é.
 *
 * As APIs de administração do Firestore e do Firebase Rules, essas sim, a
 * conta acessa. Este script lê os mesmos `firestore.rules` e
 * `firestore.indexes.json` do `firebase.json` e publica direto.
 *
 * Idempotente: índice que já existe volta 409 e é contado como pronto;
 * republicar regras idênticas é inofensivo.
 *
 * ⚠️ Os índices não são detalhe. Sem eles, extrato, contatos, avisos e
 * conciliação falham com FAILED_PRECONDITION — e só na primeira vez que
 * alguém abre aquela tela, o que faz o defeito chegar ao usuário e não ao
 * deploy.
 */

import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

import { indexConsoleLink } from '../packages/firestore/src/index-link.ts';

const PROJETO = process.env['FIREBASE_PROJECT_ID'];
const CHAVE = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
const SO_LINKS = process.argv.includes('--links');

if (!PROJETO) {
  console.error('defina FIREBASE_PROJECT_ID');
  process.exit(1);
}

function lerIndices() {
  const arquivo = JSON.parse(readFileSync('firebase.json', 'utf8')).firestore.indexes;
  return JSON.parse(readFileSync(arquivo, 'utf8')).indexes;
}

// ---------------------------------------------------------------------------
// Modo links: só imprime. Não fala com API nenhuma e, de propósito, não pede
// credencial — a razão de ele existir é justamente a credencial não bastar.
// ---------------------------------------------------------------------------

if (SO_LINKS) {
  const indices = lerIndices();

  console.log(`${indices.length} índices para criar em ${PROJETO}.`);
  console.log('');
  console.log('Abra cada link e clique em "Criar índice". A tela já vem');
  console.log('preenchida — não é preciso digitar nada.');
  console.log('');
  console.log('Pode abrir todos de uma vez: a construção roda em paralelo e');
  console.log('leva alguns minutos. Repetir um índice que já existe é inofensivo.');
  console.log('');

  for (const indice of indices) {
    const campos = indice.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`);
    console.log(`${indice.collectionGroup} — ${campos.join(', ')}`);
    console.log(indexConsoleLink(PROJETO, indice));
    console.log('');
  }

  console.log('Depois, acompanhe a construção em:');
  console.log(`https://console.firebase.google.com/project/${PROJETO}/firestore/indexes`);
  process.exit(0);
}

if (!CHAVE) {
  console.error('defina GOOGLE_APPLICATION_CREDENTIALS com o caminho da chave');
  console.error('(ou rode com --links para criar os índices pelo console)');
  process.exit(1);
}

const auth = new GoogleAuth({
  keyFile: CHAVE,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
const cliente = await auth.getClient();

const conta = JSON.parse(readFileSync(CHAVE, 'utf8')).client_email;
const firestore = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)`;
const regras = `https://firebaserules.googleapis.com/v1/projects/${PROJETO}`;

const detalhe = (err) =>
  err.response?.data?.error?.message ?? err.errors?.[0]?.message ?? String(err.message);

// A falta de permissão é o único erro esperado aqui, e é o único que o
// usuário consegue resolver. Vale gastar linhas explicando exatamente qual.
const semPermissao = (err) =>
  err.response?.status === 403 || /caller does not have permission|PERMISSION_DENIED/i.test(detalhe(err));

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------
// Publicar é criar um ruleset e apontar o release `cloud.firestore` para ele.
// O release é o que vale: um ruleset criado e não liberado não protege nada.

async function publicarRegras() {
  const arquivo = JSON.parse(readFileSync('firebase.json', 'utf8')).firestore.rules;
  const conteudo = readFileSync(arquivo, 'utf8');

  const criado = await cliente.request({
    url: `${regras}/rulesets`,
    method: 'POST',
    data: { source: { files: [{ name: arquivo, content: conteudo }] } },
  });

  await cliente.request({
    url: `${regras}/releases/cloud.firestore`,
    method: 'PATCH',
    data: {
      release: {
        name: `projects/${PROJETO}/releases/cloud.firestore`,
        rulesetName: criado.data.name,
      },
    },
  });

  return criado.data.name.split('/').pop();
}

// ---------------------------------------------------------------------------
// Índices
// ---------------------------------------------------------------------------

async function publicarIndices() {
  const indexes = lerIndices();

  let criados = 0;
  let existentes = 0;
  const falhas = [];

  for (const indice of indexes) {
    const grupo = indice.collectionGroup;
    const campos = indice.fields.map((f) => ({
      fieldPath: f.fieldPath,
      ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : { order: f.order }),
    }));
    const descricao = `${grupo}(${campos.map((c) => c.fieldPath).join(', ')})`;

    try {
      await cliente.request({
        url: `${firestore}/collectionGroups/${grupo}/indexes`,
        method: 'POST',
        data: { queryScope: indice.queryScope ?? 'COLLECTION', fields: campos },
      });
      criados++;
      console.log(`   criado   ${descricao}`);
    } catch (err) {
      const mensagem = detalhe(err);
      // 409 é "já existe" — o resultado desejado, não um problema.
      if (err.response?.status === 409 || /already exists/i.test(mensagem)) {
        existentes++;
        console.log(`   existe   ${descricao}`);
      } else {
        falhas.push({ descricao, mensagem, err });
        console.log(`   FALHOU   ${descricao}`);
      }
    }
  }

  return { criados, existentes, falhas, total: indexes.length };
}

function explicarPermissao() {
  console.error('');
  console.error('   A conta de serviço pode ler e escrever dados, mas não pode');
  console.error('   criar índices. São permissões diferentes, e a chave do');
  console.error('   Firebase vem só com a primeira.');
  console.error('');
  console.error('   Sem os índices o sistema não funciona — nem o login, que');
  console.error('   consulta authAttempts para contar tentativas.');
  console.error('');
  console.error('   ── Caminho 1: liberar a permissão (uma vez, resolve tudo) ──');
  console.error('');
  console.error(`   1. https://console.cloud.google.com/iam-admin/iam?project=${PROJETO}`);
  console.error(`   2. Encontre ${conta}`);
  console.error('   3. Editar (lápis) → Adicionar outra função');
  console.error('   4. Escolha "Administrador de índices do Cloud Datastore"');
  console.error('      (Cloud Datastore Index Admin)');
  console.error('   5. Salvar, esperar ~1 minuto e rodar este comando de novo.');
  console.error('');
  console.error('   Pela linha de comando, se preferir:');
  console.error('');
  console.error(`   gcloud projects add-iam-policy-binding ${PROJETO} \\`);
  console.error(`     --member=serviceAccount:${conta} \\`);
  console.error('     --role=roles/datastore.indexAdmin');
  console.error('');
  console.error('   ── Caminho 2: sem mexer no IAM ──');
  console.error('');
  console.error('   Logado no console como você mesmo, a permissão existe. Este');
  console.error('   comando imprime um link por índice, já preenchido:');
  console.error('');
  console.error('     npm run firebase:links');
}

// ---------------------------------------------------------------------------

console.log(`projeto: ${PROJETO}`);
console.log(`conta:   ${conta}`);
console.log('');

// Regras e índices são independentes, e as permissões dos dois também: dá
// para ter uma e não a outra. Por isso a falha de um não interrompe o outro
// — abortar aqui só faria o usuário resolver os problemas em série.
let regrasOk = true;

console.log('→ regras de segurança');
try {
  const id = await publicarRegras();
  console.log(`   publicado ruleset ${id}`);
} catch (err) {
  regrasOk = false;
  console.error(`   FALHOU: ${detalhe(err)}`);
  if (semPermissao(err)) {
    console.error('   A conta precisa do papel "Firebase Rules Admin".');
  }
}

console.log('');
console.log('→ índices');
const { criados, existentes, falhas, total } = await publicarIndices();

console.log('');
console.log(`${criados} criados, ${existentes} já existiam, ${falhas.length} falharam (de ${total})`);

if (falhas.length > 0) {
  if (falhas.every(({ err }) => semPermissao(err))) {
    explicarPermissao();
  } else {
    console.error('');
    for (const f of falhas) console.error(`   ${f.descricao}: ${f.mensagem.slice(0, 200)}`);
  }
}

if (falhas.length > 0 || !regrasOk) process.exit(1);

// A construção é assíncrona: o índice existe mas leva alguns minutos para
// ficar utilizável. Consultá-lo antes disso ainda devolve FAILED_PRECONDITION.
if (criados > 0) {
  console.log('');
  console.log('A construção leva alguns minutos. Acompanhe em:');
  console.log(`https://console.firebase.google.com/project/${PROJETO}/firestore/indexes`);
}
