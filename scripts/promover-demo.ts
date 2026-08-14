/** Concede acesso de operador ao usuário mais recente. Só para a demonstração. */
import { COLLECTIONS, createDb, createFirestore } from '@depix/firestore';

const fs = createFirestore({
  projectId: process.env['FIREBASE_PROJECT_ID']!,
  emulatorHost: process.env['FIRESTORE_EMULATOR_HOST']!,
});
const db = createDb(fs);

const users = await db.collection(COLLECTIONS.users).orderBy('createdAt', 'desc').limit(1).get();
const userId = users.docs[0]!.id;

await db.doc(`${COLLECTIONS.adminUsers}/${userId}`).set({
  role: 'operator',
  addedBy: 'demo',
  createdAt: new Date(),
});

console.log('operador:', userId);
await db.close();
