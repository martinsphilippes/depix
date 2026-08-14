/** Credita saldo do usuário mais recente. Só para a demonstração local. */
import { COLLECTIONS, createDb, createFirestore } from '@depix/firestore';
import { creditAvailable } from '@depix/ledger';
import { money } from '@depix/core';

const fs = createFirestore({
  projectId: process.env['FIREBASE_PROJECT_ID']!,
  emulatorHost: process.env['FIRESTORE_EMULATOR_HOST']!,
});
const db = createDb(fs);

const users = await db.collection(COLLECTIONS.users).orderBy('createdAt', 'desc').limit(1).get();
const userId = users.docs[0]!.id;

await creditAvailable(
  db,
  { transactionId: `demo-credito-${userId}`, userId, actor: 'demo' },
  money('DEPIX', 120_000_000_000n), // R$ 1.200,00
);

console.log('creditado para', userId);
await db.close();
