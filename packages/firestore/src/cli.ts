#!/usr/bin/env node
/**
 * CLI de bootstrap.
 *
 *   npm run bootstrap                        # ativos, contas de sistema, providers
 *   npm run bootstrap -- check               # só verifica, não escreve
 *   npm run bootstrap -- admin <userId> [papel]   # concede acesso ao painel
 *
 * Substitui o `migrate` da versão PostgreSQL. O Firestore não tem schema
 * declarado nem migração de DDL — o que precisa existir antes de qualquer
 * operação são os documentos de referência.
 *
 * Trava de segurança: escrever no projeto real exige intenção explícita.
 * Com Firestore, a diferença entre desenvolvimento e produção é uma variável
 * de ambiente, e é fácil demais errar.
 */

import { bootstrap } from './bootstrap.ts';
import { createFirestore } from './client.ts';
import { createDb } from './db.ts';
import { COLLECTIONS } from './paths.ts';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'bootstrap';
  const projectId = process.env['FIREBASE_PROJECT_ID'];
  const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];

  if (!projectId) {
    console.error('FIREBASE_PROJECT_ID não definida.');
    process.exit(1);
  }

  if (!emulatorHost && process.env['ALLOW_REAL_FIRESTORE'] !== 'yes') {
    console.error(
      `Sem FIRESTORE_EMULATOR_HOST, isto escreveria no projeto real "${projectId}".\n` +
        'Defina FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 para o emulador, ' +
        'ou ALLOW_REAL_FIRESTORE=yes se for mesmo essa a intenção.',
    );
    process.exit(1);
  }

  const fs = createFirestore({
    projectId,
    ...(emulatorHost ? { emulatorHost } : {}),
  });
  const db = createDb(fs);

  try {
    if (command === 'check') {
      const [assets, accounts, providers] = await Promise.all([
        db.collection(COLLECTIONS.assets).count().get(),
        db.collection(COLLECTIONS.ledgerAccounts).count().get(),
        db.collection(COLLECTIONS.providers).count().get(),
      ]);
      console.log(`destino: ${emulatorHost ? `emulador ${emulatorHost}` : `projeto ${projectId}`}`);
      console.log(`ativos:            ${assets.data().count}`);
      console.log(`contas contábeis:  ${accounts.data().count}`);
      console.log(`providers:         ${providers.data().count}`);
      return;
    }

    if (command === 'admin') {
      // Conceder acesso administrativo é operação de console, não de HTTP.
      // Uma rota de "promover a admin" é o alvo que um atacante com sessão
      // procura — aqui exige-se acesso ao ambiente, que é uma barreira de
      // outra natureza.
      const userId = process.argv[3];
      const papel = process.argv[4] ?? 'operator';

      if (!userId) {
        console.error('uso: npm run bootstrap -- admin <userId> [operator|auditor]');
        process.exit(1);
      }
      if (papel !== 'operator' && papel !== 'auditor') {
        console.error(`papel inválido: ${papel}. Use "operator" ou "auditor".`);
        process.exit(1);
      }

      const usuario = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
      if (!usuario.exists) {
        // Sem esta checagem, um erro de digitação criaria um admin para um
        // usuário que não existe — e ninguém notaria até alguém criar a conta
        // com aquele ID.
        console.error(`usuário "${userId}" não existe. Nada foi gravado.`);
        process.exit(1);
      }

      await db.doc(`${COLLECTIONS.adminUsers}/${userId}`).set({
        role: papel,
        addedBy: 'cli',
        createdAt: new Date(),
      });
      await db.collection(COLLECTIONS.auditLogs).add({
        actorKind: 'admin',
        actorId: 'cli',
        action: 'admin.granted',
        objectKind: 'user',
        objectId: userId,
        reason: 'concedido por console de operação',
        metadata: { role: papel },
        ipHash: null,
        createdAt: new Date(),
      });

      console.log(`acesso "${papel}" concedido a ${userId}`);
      return;
    }

    const result = await bootstrap(db);
    console.log(`destino: ${emulatorHost ? `emulador ${emulatorHost}` : `projeto ${projectId}`}`);
    console.log(
      `ativos=${result.assets} contas=${result.accounts} providers=${result.providers} taxas=${result.feeRules}`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
