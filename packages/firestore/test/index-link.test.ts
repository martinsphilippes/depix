import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encodeCompositeIndex, indexConsoleLink } from '../src/index-link.ts';

/**
 * Este link foi capturado de um erro FAILED_PRECONDITION real, devolvido pelo
 * Firestore do projeto depix-6d109 ao tentar login sem os índices publicados.
 * É a única fonte de verdade que existe para este formato — não há
 * documentação. Se a codificação daqui divergir, os links levam o console a
 * criar um índice diferente do necessário, e o defeito só aparece muito
 * depois, em produção.
 */
const REAL =
  'ClBwcm9qZWN0cy9kZXBpeC02ZDEwOS9kYXRhYmFzZXMvKGRlZmF1bHQpL2NvbGxlY3Rpb2' +
  '5Hcm91cHMvYXV0aEF0dGVtcHRzL2luZGV4ZXMvXxABGggKBGtpbmQQARoLCgdzdWJqZWN0' +
  'EAEaDQoJc3VjY2VlZGVkEAEaDQoJY3JlYXRlZEF0EAEaDAoIX19uYW1lX18QAQ';

describe('link de criação de índice no console', () => {
  it('reproduz byte a byte o payload que o Firestore devolveu', () => {
    const payload = encodeCompositeIndex('depix-6d109', {
      collectionGroup: 'authAttempts',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'kind', order: 'ASCENDING' },
        { fieldPath: 'subject', order: 'ASCENDING' },
        { fieldPath: 'succeeded', order: 'ASCENDING' },
        { fieldPath: 'createdAt', order: 'ASCENDING' },
      ],
    });

    assert.equal(payload, REAL);
  });

  it('o __name__ herda a direção do último campo ordenado', () => {
    // Com a direção errada, o console monta um índice que não serve à
    // consulta — e o erro só reaparece quando alguém abre a tela.
    const decodificado = (base64: string) => Buffer.from(base64, 'base64').toString('binary');

    const desc = decodificado(
      encodeCompositeIndex('p', {
        collectionGroup: 'transactions',
        fields: [
          { fieldPath: 'userId', order: 'ASCENDING' },
          { fieldPath: 'createdAt', order: 'DESCENDING' },
        ],
      }),
    );

    // \x0a\x08__name__\x10\x02 → fieldPath __name__, order DESCENDING
    assert.ok(desc.endsWith('\n\b__name__\x10\x02'), 'esperava __name__ DESCENDING');

    const asc = decodificado(
      encodeCompositeIndex('p', {
        collectionGroup: 'contacts',
        fields: [
          { fieldPath: 'userId', order: 'ASCENDING' },
          { fieldPath: 'label', order: 'ASCENDING' },
        ],
      }),
    );
    assert.ok(asc.endsWith('\n\b__name__\x10\x01'), 'esperava __name__ ASCENDING');
  });

  it('codifica arrayConfig como CONTAINS, não como ordem', () => {
    const bytes = Buffer.from(
      encodeCompositeIndex('p', {
        collectionGroup: 'coisas',
        fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }],
      }),
      'base64',
    ).toString('binary');

    // campo 3 (arrayConfig) = \x18\x01, e não campo 2 (order) = \x10
    assert.ok(bytes.includes('\n\x04tags\x18\x01'), 'esperava arrayConfig CONTAINS');
  });

  it('o link aponta para o projeto certo e carrega o payload', () => {
    const url = indexConsoleLink('meu-projeto', {
      collectionGroup: 'contacts',
      fields: [{ fieldPath: 'userId', order: 'ASCENDING' }],
    });

    assert.match(url, /^https:\/\/console\.firebase\.google\.com\/v1\/r\/project\/meu-projeto\//);
    assert.match(url, /create_composite=/);
    const payload = new URL(url).searchParams.get('create_composite') ?? '';
    assert.match(
      Buffer.from(payload, 'base64').toString('utf8'),
      /projects\/meu-projeto\/databases\/\(default\)\/collectionGroups\/contacts\//,
    );
  });
});
