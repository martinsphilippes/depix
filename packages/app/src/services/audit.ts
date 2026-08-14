/**
 * Trilha de auditoria (§24-25, §37).
 *
 * Três lugares já escreviam em `auditLogs` cada um do seu jeito. Isso é
 * aceitável até a primeira vez que alguém precisa responder "quem alterou
 * este limite, quando e por quê" e descobre que metade dos registros não tem
 * motivo. Este módulo centraliza o formato e faz valer a única regra que a
 * trilha realmente precisa ter:
 *
 *   **ação administrativa exige motivo.** Não como convenção — como erro em
 *   tempo de execução. Um painel que deixa bloquear um saque sem dizer por
 *   quê produz uma trilha que não serve para auditar nada.
 *
 * ⚠️ `metadata` vai para o registro tal como veio. Nunca coloque aqui seed,
 * chave, token, senha, CPF ou dado sensível completo (§37) — o log é
 * exatamente o lugar de onde esses dados vazam depois.
 */

import type { Query } from '@google-cloud/firestore';

import { DomainError } from '@depix/core';
import { COLLECTIONS, type AuditLogDoc, type Db } from '@depix/firestore';

export interface AuditParams {
  readonly actorKind: AuditLogDoc['actorKind'];
  readonly actorId?: string | null;
  readonly action: string;
  readonly objectKind?: string | null;
  readonly objectId?: string | null;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly ipHash?: string | null;
  readonly now?: Date;
}

/**
 * Campos cujo nome sugere segredo. Aparecer aqui é bug, não descuido tolerável.
 *
 * O separador entre palavras é opcional de propósito: a primeira versão desta
 * expressão listava `private_key` e deixava `privateKey` passar — e o teste
 * pegou. Nomes em JavaScript são camelCase com muito mais frequência do que
 * snake_case.
 */
const PROIBIDOS = new RegExp(
  [
    'seed',
    'mnemonic',
    'xprv',
    'tprv',
    'priv[_-]?key',
    'private[_-]?key',
    'blinding[_-]?key',
    'secret',
    'token',
    'password',
    'senha',
    'cpf',
    'cnpj',
  ].join('|'),
  'i',
);

export async function writeAuditLog(db: Db, params: AuditParams): Promise<void> {
  if (params.actorKind === 'admin' && !params.reason?.trim()) {
    throw new DomainError(
      'audit_reason_required',
      'Ação administrativa exige motivo registrado. Sem isso a trilha não serve para auditar.',
    );
  }

  const metadata = params.metadata ?? {};
  for (const chave of Object.keys(metadata)) {
    if (PROIBIDOS.test(chave)) {
      throw new DomainError(
        'sensitive_field_in_audit',
        `O campo "${chave}" não pode ir para a trilha de auditoria (§37).`,
      );
    }
  }

  const doc: AuditLogDoc = {
    actorKind: params.actorKind,
    actorId: params.actorId ?? null,
    action: params.action,
    objectKind: params.objectKind ?? null,
    objectId: params.objectId ?? null,
    reason: params.reason ?? null,
    metadata,
    ipHash: params.ipHash ?? null,
    createdAt: params.now ?? new Date(),
  };

  await db.collection(COLLECTIONS.auditLogs).add(doc as unknown as Record<string, unknown>);
}

export interface AuditEntry extends AuditLogDoc {
  readonly id: string;
}

/** Leitura da trilha, para o painel. Mais recentes primeiro. */
export async function listAuditLogs(
  db: Db,
  filtro: { objectId?: string; actorId?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  // Os `where` vêm antes do `orderBy`: é a ordem que o Firestore espera para
  // casar com o índice composto (firestore.indexes.json).
  let query: Query = db.collection(COLLECTIONS.auditLogs);
  if (filtro.objectId) query = query.where('objectId', '==', filtro.objectId);
  if (filtro.actorId) query = query.where('actorId', '==', filtro.actorId);

  const snap = await query.orderBy('createdAt', 'desc').limit(filtro.limit ?? 100).get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as unknown as AuditLogDoc),
  }));
}
