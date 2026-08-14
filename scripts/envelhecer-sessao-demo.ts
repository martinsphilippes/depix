/**
 * Envelhece as sessões: apaga `reauthAt`.
 *
 * É o estado natural de qualquer sessão passada a janela de confirmação. Só
 * para a demonstração — permite ver a política de segurança bloqueando sem
 * esperar o relógio.
 */
import { COLLECTIONS, createDb, createFirestore } from '@depix/firestore';

const fs = createFirestore({
  projectId: process.env['FIREBASE_PROJECT_ID']!,
  emulatorHost: process.env['FIRESTORE_EMULATOR_HOST']!,
});
const db = createDb(fs);

const sessoes = await db.collection(COLLECTIONS.sessions).get();
const batch = db.fs.batch();
for (const doc of sessoes.docs) batch.update(doc.ref, { reauthAt: null });
await batch.commit();

console.log('sessões envelhecidas:', sessoes.size);
await db.close();
