/**
 * Registro da carteira.
 *
 * O usuário gera as chaves no dispositivo e envia ao servidor **apenas** o
 * descriptor CT watch-only. É o único artefato que atravessa essa fronteira.
 *
 * Este módulo é o guardião dela: qualquer coisa que pareça material de chave
 * privada é recusada antes de tocar o banco. A verificação é redundante com a
 * do cliente — de propósito. Um cliente adulterado, ou um bug numa versão
 * futura da UI, não pode conseguir gravar uma seed no nosso banco.
 */

import { DomainError } from '@depix/core';
import { COLLECTIONS, type Db, type WalletDoc } from '@depix/firestore';

import { encryptAtRest } from '../crypto/at-rest.ts';

/**
 * Padrões que denunciam material capaz de **gastar**.
 *
 * `xprv`/`tprv` são chaves estendidas privadas: quem as tem move os fundos.
 * Uma sequência longa de palavras minúsculas tem cara de mnemônico.
 */
const SPENDING_KEY_MARKERS = [/xprv[0-9a-zA-Z]{50,}/, /tprv[0-9a-zA-Z]{50,}/];

/**
 * Recusa qualquer coisa capaz de gastar.
 *
 * ⚠️ Distinção que importa e é fácil de errar: o `slip77(<64 hex>)` presente
 * num descriptor CT legítimo **é** a master blinding key, e ela é esperada
 * aqui. Ela permite *desblindar* — ou seja, ver valores — e **não** permite
 * gastar. É exatamente o trade-off declarado em SECURITY.md §2: ver-sem-poder-
 * gastar é o preço de detectar depósitos e conciliar no servidor, e é por isso
 * que o descriptor é cifrado em repouso.
 *
 * Recusar `slip77` aqui tornaria impossível registrar qualquer carteira.
 * O que não pode passar é chave de assinatura.
 */
export function assertNoPrivateMaterial(descriptor: string): void {
  const candidate = descriptor.trim();

  for (const marker of SPENDING_KEY_MARKERS) {
    if (marker.test(candidate)) {
      throw new DomainError(
        'private_material_rejected',
        'O descriptor enviado contém uma chave capaz de gastar. Envie apenas o descriptor ' +
          'watch-only — chaves de assinatura nunca devem sair do seu dispositivo.',
      );
    }
  }

  // Um mnemônico BIP-39 tem 12 ou 24 palavras minúsculas.
  const words = candidate.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    throw new DomainError(
      'private_material_rejected',
      'Isto parece uma frase de recuperação, não um descriptor. Ela nunca deve ser enviada.',
    );
  }

  if (!candidate.startsWith('ct(')) {
    throw new DomainError(
      'invalid_descriptor',
      'O descriptor precisa ser confidencial (formato ct(...)).',
    );
  }
}

export interface RegisterWalletParams {
  readonly userId: string;
  readonly ctDescriptor: string;
  readonly network: 'mainnet' | 'testnet';
  readonly encryptionKey: Buffer;
}

/**
 * Grava (ou atualiza) o descriptor watch-only do usuário.
 *
 * Trocar o descriptor de uma carteira que já tem histórico é operação
 * perigosa — passaria a observar outra carteira e o saldo exibido deixaria de
 * corresponder ao ledger. Por isso a troca é recusada; recuperação de conta é
 * outro fluxo, com outras verificações.
 */
export async function registerWallet(
  db: Db,
  params: RegisterWalletParams,
): Promise<{ walletId: string; created: boolean }> {
  assertNoPrivateMaterial(params.ctDescriptor);

  const existing = await db
    .collection(COLLECTIONS.wallets)
    .where('userId', '==', params.userId)
    .limit(1)
    .get();

  const encrypted = encryptAtRest(params.ctDescriptor.trim(), params.encryptionKey);

  if (!existing.empty) {
    const doc = existing.docs[0]!;
    const current = doc.data() as WalletDoc;

    if (current.ctDescriptorEnc) {
      throw new DomainError(
        'wallet_already_registered',
        'Esta conta já tem uma carteira registrada. Trocar o descriptor faria o saldo ' +
          'exibido deixar de corresponder ao histórico — use o fluxo de recuperação.',
      );
    }

    await doc.ref.update({ ctDescriptorEnc: encrypted });
    return { walletId: doc.id, created: false };
  }

  const walletDoc: WalletDoc = {
    userId: params.userId,
    custodyModel: 'self',
    ctDescriptorEnc: encrypted,
    backupStatus: 'none',
    createdAt: new Date(),
  };

  const ref = db.collection(COLLECTIONS.wallets).doc();
  await ref.create(walletDoc as unknown as Record<string, unknown>);
  return { walletId: ref.id, created: true };
}

/** Confirma que o usuário fez o backup da frase antes de receber dinheiro. */
export async function markBackupConfirmed(db: Db, userId: string): Promise<void> {
  const snap = await db
    .collection(COLLECTIONS.wallets)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) throw new DomainError('wallet_not_found', 'Carteira não registrada');

  await doc.ref.update({ backupStatus: 'user_confirmed' });
}

export interface WalletStatus {
  readonly walletId: string;
  readonly registered: boolean;
  readonly backupConfirmed: boolean;
  readonly custodyModel: string;
}

export async function getWalletStatus(db: Db, userId: string): Promise<WalletStatus | null> {
  const snap = await db
    .collection(COLLECTIONS.wallets)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) return null;

  const wallet = doc.data() as WalletDoc;
  return {
    walletId: doc.id,
    registered: wallet.ctDescriptorEnc !== null,
    backupConfirmed: wallet.backupStatus !== 'none',
    custodyModel: wallet.custodyModel,
  };
}
