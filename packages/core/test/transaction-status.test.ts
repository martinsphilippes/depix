import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TX_STATUSES,
  assertActorMayComplete,
  assertTransition,
  canTransition,
  isTerminal,
  userFacingLabel,
} from '../src/transaction-status.ts';

describe('máquina de estados', () => {
  it('percorre o caminho feliz do Pix → DePix', () => {
    const caminho = [
      'CREATED',
      'WAITING_PAYMENT',
      'PIX_RECEIVED',
      'CONVERTING',
      'DEPIX_SENT',
      'CONFIRMING',
      'COMPLETED',
    ] as const;
    for (let i = 0; i < caminho.length - 1; i++) {
      assert.ok(
        canTransition(caminho[i]!, caminho[i + 1]!),
        `${caminho[i]} → ${caminho[i + 1]} deveria ser válida`,
      );
    }
  });

  it('COMPLETED só é alcançável a partir de CONFIRMING ou MANUAL_REVIEW', () => {
    // Esta é a invariante central do módulo: nenhum atalho para "concluída".
    const origens = TX_STATUSES.filter((s) => canTransition(s, 'COMPLETED'));
    assert.deepEqual([...origens].sort(), ['CONFIRMING', 'MANUAL_REVIEW']);
  });

  it('nenhum atalho de CREATED ou PIX_RECEIVED para COMPLETED', () => {
    assert.equal(canTransition('CREATED', 'COMPLETED'), false);
    assert.equal(canTransition('PIX_RECEIVED', 'COMPLETED'), false);
    assert.equal(canTransition('WAITING_PAYMENT', 'COMPLETED'), false);
    assert.equal(canTransition('DEPIX_SENT', 'COMPLETED'), false);
  });

  it('estados terminais não têm saída', () => {
    for (const s of ['COMPLETED', 'CANCELLED', 'REFUNDED'] as const) {
      assert.ok(isTerminal(s));
      for (const to of TX_STATUSES) {
        assert.equal(canTransition(s, to), false, `${s} não deveria sair para ${to}`);
      }
    }
  });

  it('FAILED é terminal mas admite estorno posterior', () => {
    assert.ok(isTerminal('FAILED'));
    assert.ok(canTransition('FAILED', 'REFUNDED'));
  });

  it('qualquer estado ativo pode cair em MANUAL_REVIEW', () => {
    for (const s of ['CREATED', 'WAITING_PAYMENT', 'PIX_RECEIVED', 'CONVERTING', 'DEPIX_SENT', 'CONFIRMING'] as const) {
      assert.ok(canTransition(s, 'MANUAL_REVIEW'), `${s} deveria poder ir a MANUAL_REVIEW`);
    }
  });

  it('assertTransition lança com código estável', () => {
    assert.throws(() => assertTransition('CREATED', 'COMPLETED'), (e: unknown) => {
      assert.ok(e instanceof Error && 'code' in e);
      assert.equal((e as { code: string }).code, 'invalid_transition');
      return true;
    });
  });
});

describe('autoridade para concluir', () => {
  it('worker que verificou confirmação pode concluir a partir de CONFIRMING', () => {
    assert.doesNotThrow(() => assertActorMayComplete('CONFIRMING', 'worker:liquid-confirm'));
    assert.doesNotThrow(() => assertActorMayComplete('CONFIRMING', 'system'));
  });

  it('webhook sozinho NÃO conclui uma transação', () => {
    // Um HTTP 200 ou um webhook isolado nunca é confirmação final (regra 43).
    assert.throws(() => assertActorMayComplete('CONFIRMING', 'webhook:depixapp'));
  });

  it('usuário nunca conclui a própria transação', () => {
    assert.throws(() => assertActorMayComplete('CONFIRMING', 'user:abc'));
  });

  it('admin conclui apenas a partir de MANUAL_REVIEW', () => {
    assert.doesNotThrow(() => assertActorMayComplete('MANUAL_REVIEW', 'admin:op-1'));
    assert.throws(() => assertActorMayComplete('CONFIRMING', 'admin:op-1'));
  });
});

describe('rótulos para o usuário', () => {
  it('não expõem jargão técnico', () => {
    const jargao = /blockchain|utxo|liquid|confirmação de bloco|invoice|node|channel/i;
    for (const s of TX_STATUSES) {
      assert.doesNotMatch(userFacingLabel(s, 'pix_in_to_depix'), jargao);
    }
  });

  it('adapta o texto ao tipo de operação', () => {
    assert.equal(userFacingLabel('CONVERTING', 'pix_in_to_depix'), 'Adicionando à carteira');
    assert.equal(userFacingLabel('CONVERTING', 'depix_send'), 'Processando');
  });
});
