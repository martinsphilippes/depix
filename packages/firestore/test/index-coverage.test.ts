import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  findCoveringIndex,
  needsCompositeIndex,
  uncoveredQueries,
  type DeclaredIndex,
  type QueryShape,
} from '../src/index-coverage.ts';

const DECLARADOS: DeclaredIndex[] = JSON.parse(
  readFileSync(new URL('../../../firestore.indexes.json', import.meta.url), 'utf8'),
).indexes;

/**
 * Toda consulta do código que combina igualdade com faixa ou ordenação.
 *
 * Consulta só de igualdades fica de fora de propósito: o Firestore a resolve
 * juntando índices de campo único, e declarar um composto ali só encareceria
 * a escrita — o que pesa justamente na coleção mais escrita, transactions.
 *
 * Manter esta lista à mão é o preço de o emulador não exigir índices. Ao
 * acrescentar uma consulta ao código, acrescente-a aqui: é este teste que
 * evita descobrir a falta em produção.
 */
const CONSULTAS: QueryShape[] = [
  // --- autenticação e limites ---
  // Sem orderBy: a faixa implica ordenação ascendente, então rangeDirection
  // fica de fora e o padrão (ASCENDING) vale. Verificado contra o projeto
  // real — o índice DESC pronto foi recusado.
  {
    origem: 'rate-limit.ts countRecentAttempts (mode=failures)',
    collectionGroup: 'authAttempts',
    equality: ['subject', 'kind', 'succeeded'],
    range: 'createdAt',
  },
  {
    origem: 'rate-limit.ts countRecentAttempts (mode=all) — throttling financeiro',
    collectionGroup: 'authAttempts',
    equality: ['subject', 'kind'],
    range: 'createdAt',
  },
  {
    origem: 'limits.ts consumo da janela — sem orderBy',
    collectionGroup: 'transactions',
    equality: ['userId'],
    range: 'createdAt',
  },

  // --- extrato: orderBy('createdAt', 'desc') ---
  {
    origem: 'history.ts listHistory',
    collectionGroup: 'transactions',
    equality: ['userId'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },
  {
    origem: 'history.ts listHistory + kinds',
    collectionGroup: 'transactions',
    equality: ['userId', 'kind'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },
  {
    origem: 'history.ts listHistory + statuses',
    collectionGroup: 'transactions',
    equality: ['userId', 'status'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },
  {
    origem: 'history.ts listHistory + kinds + statuses',
    collectionGroup: 'transactions',
    equality: ['userId', 'kind', 'status'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },

  // --- taxas: orderBy('activeFrom', 'desc') ---
  {
    origem: 'fees.ts regra vigente',
    collectionGroup: 'feeRules',
    equality: ['operation'],
    range: 'activeFrom',
    rangeDirection: 'DESCENDING',
  },

  // --- fila ---
  {
    origem: 'queue.ts claim de job — orderBy(runAfter) ascendente',
    collectionGroup: 'jobQueue',
    equality: ['queue', 'completedAt', 'failedAt'],
    range: 'runAfter',
  },
  {
    origem: 'queue.ts listDeadLetters + fila — != sem orderBy',
    collectionGroup: 'jobQueue',
    equality: ['queue'],
    range: 'failedAt',
  },

  // --- avisos: orderBy('createdAt', 'desc') ---
  // (contacts fica de fora: listContacts só filtra igualdade e ordena em
  // memória, então índice de campo único basta.)
  {
    origem: 'notifications.ts listagem',
    collectionGroup: 'notifications',
    equality: ['userId'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },

  // --- trilha de auditoria: orderBy('createdAt', 'desc') ---
  {
    origem: 'audit.ts listAuditLogs por objeto',
    collectionGroup: 'auditLogs',
    equality: ['objectId'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },
  {
    origem: 'audit.ts listAuditLogs por ator',
    collectionGroup: 'auditLogs',
    equality: ['actorId'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },
  {
    origem: 'audit.ts listAuditLogs por objeto e ator',
    collectionGroup: 'auditLogs',
    equality: ['objectId', 'actorId'],
    range: 'createdAt',
    rangeDirection: 'DESCENDING',
  },

  // --- conciliação: orderBy('startedAt', 'desc') ---
  {
    origem: 'reconciliation.ts execuções recentes',
    collectionGroup: 'reconciliationRuns',
    equality: ['status'],
    range: 'startedAt',
    rangeDirection: 'DESCENDING',
  },
];

describe('cobertura de índices do Firestore', () => {
  it('toda consulta do código tem índice declarado', () => {
    // O emulador não exige índices: sem este teste, a falta só apareceria no
    // projeto real, na primeira vez que alguém executasse a operação.
    const faltando = uncoveredQueries(CONSULTAS, DECLARADOS);

    assert.deepEqual(
      faltando.map((q) => `${q.origem} → ${q.collectionGroup}`),
      [],
      'consultas sem índice que as cubra',
    );
  });

  it('nenhum índice declarado é de campo único', () => {
    // O Firestore cria índices de campo único sozinho, e RECUSA declará-los:
    // "this index is not necessary, configure using single field index
    // controls". Três estavam no arquivo desde o início e só apareceram ao
    // publicar num projeto real.
    const unicos = DECLARADOS.filter((i) => i.fields.length < 2).map(
      (i) => `${i.collectionGroup}(${i.fields.map((f) => f.fieldPath).join(', ')})`,
    );

    assert.deepEqual(unicos, [], 'índices de campo único são automáticos e o Firestore os recusa');
  });

  it('um campo a mais no meio do índice não conta como cobertura', () => {
    // Foi exatamente o defeito encontrado: o índice de authAttempts trazia
    // `succeeded` entre as igualdades e `createdAt`, e por isso não servia à
    // consulta que não filtra succeeded.
    const indiceComSobra: DeclaredIndex[] = [
      {
        collectionGroup: 'authAttempts',
        fields: [
          { fieldPath: 'subject' },
          { fieldPath: 'kind' },
          { fieldPath: 'succeeded' },
          { fieldPath: 'createdAt' },
        ],
      },
    ];

    const consulta: QueryShape = {
      origem: 'teste',
      collectionGroup: 'authAttempts',
      equality: ['subject', 'kind'],
      range: 'createdAt',
    };

    assert.equal(findCoveringIndex(consulta, indiceComSobra), undefined);
  });

  it('direção errada no campo de faixa não conta como cobertura', () => {
    // Segundo defeito real encontrado: o índice de authAttempts, já com os
    // campos certos, estava DESC — e a consulta, sem orderBy, implica ASC.
    // O Firestore o recusou mesmo pronto.
    const indiceDesc: DeclaredIndex[] = [
      {
        collectionGroup: 'authAttempts',
        fields: [
          { fieldPath: 'subject' },
          { fieldPath: 'kind' },
          { fieldPath: 'createdAt', order: 'DESCENDING' },
        ],
      },
    ];

    const semOrderBy: QueryShape = {
      origem: 'teste',
      collectionGroup: 'authAttempts',
      equality: ['subject', 'kind'],
      range: 'createdAt',
    };

    assert.equal(findCoveringIndex(semOrderBy, indiceDesc), undefined);
    assert.ok(findCoveringIndex({ ...semOrderBy, rangeDirection: 'DESCENDING' }, indiceDesc));
  });

  it('a ordem entre os campos de igualdade não importa', () => {
    // O próprio Firestore devolve esses campos em ordem alfabética quando
    // sugere um índice, e não na ordem em que a consulta os aplica.
    const indice: DeclaredIndex[] = [
      {
        collectionGroup: 'authAttempts',
        fields: [{ fieldPath: 'kind' }, { fieldPath: 'subject' }, { fieldPath: 'createdAt' }],
      },
    ];

    assert.ok(
      findCoveringIndex(
        {
          origem: 'teste',
          collectionGroup: 'authAttempts',
          equality: ['subject', 'kind'],
          range: 'createdAt',
        },
        indice,
      ),
    );
  });

  it('consulta só de igualdades não exige índice composto', () => {
    // O Firestore junta os índices de campo único. Declarar um composto aqui
    // só encareceria a escrita.
    assert.equal(
      needsCompositeIndex({
        origem: 'security-policy.ts isNewRecipient',
        collectionGroup: 'transactions',
        equality: ['userId', 'counterparty'],
      }),
      false,
    );
  });

  it('faixa sozinha, sem igualdade, também não exige', () => {
    assert.equal(
      needsCompositeIndex({
        origem: 'reconciliation.ts transações paradas',
        collectionGroup: 'transactions',
        equality: [],
        range: 'updatedAt',
      }),
      false,
    );
  });
});
