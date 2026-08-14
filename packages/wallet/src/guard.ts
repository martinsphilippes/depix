/**
 * Validação pré-transmissão.
 *
 * ⚠️ ESTE É O CÓDIGO MAIS PERIGOSO DO SISTEMA.
 *
 * O saque DePix → Pix exige que a taxa do operador seja paga numa saída
 * **explícita (não-blindada)**. A documentação do provider é literal sobre a
 * consequência de errar: pagar a taxa de forma blindada faz a operação
 * falhar e *pode perder os fundos*. Não é erro de UX — é perda de dinheiro.
 *
 * Por isso a decisão está separada da extração:
 *
 *   • `assertWithdrawalOutputs` é uma **função pura** sobre formas de saída
 *     já extraídas. Ela pode ser testada exaustivamente, com todos os casos
 *     de erro, sem PSET, sem rede, sem carteira financiada.
 *   • `extractOutputs` é um adaptador pequeno e revisável que lê o PSET.
 *
 * A regra que governa o módulo: **na dúvida, aborta**. Uma transação não
 * transmitida custa ao usuário um novo clique. Uma transação transmitida
 * errada custa o dinheiro dele.
 */

import { DomainError } from '@depix/core';

/** Forma de uma saída, independente do SDK. */
export interface OutputShape {
  /** Script da saída em hex — identifica o destinatário. */
  readonly scriptHex: string;
  /**
   * `true` quando a saída é explícita (não-blindada): valor e ativo visíveis
   * na cadeia. No LWK, corresponde a `blinderIndex() === undefined`.
   */
  readonly isExplicit: boolean;
  /** Conhecido apenas em saída explícita (ou construída por nós). */
  readonly assetId: string | null;
  readonly amount: bigint | null;
}

export interface WithdrawalExpectation {
  /** Script do endereço do operador — recebe o principal, confidencial. */
  readonly depositScriptHex: string;
  /** Script do endereço de taxa — recebe a taxa, EXPLÍCITA. */
  readonly feeScriptHex: string;
  readonly feeAmount: bigint;
  /** Asset ID do DePix, em minúsculas. */
  readonly assetId: string;
}

export class UnsafeTransactionError extends DomainError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(
      'unsafe_transaction',
      `Transação abortada antes de transmitir: ${reason}`,
      details,
    );
    this.name = 'UnsafeTransactionError';
  }
}

/**
 * Valida as saídas de um saque antes de assinar/transmitir.
 *
 * Lança `UnsafeTransactionError` em qualquer desvio. Nunca devolve booleano:
 * um chamador que esqueça de checar o retorno transmitiria a transação.
 */
export function assertWithdrawalOutputs(
  outputs: readonly OutputShape[],
  expectation: WithdrawalExpectation,
): void {
  const expectedAsset = expectation.assetId.toLowerCase();
  const feeScript = expectation.feeScriptHex.toLowerCase();
  const depositScript = expectation.depositScriptHex.toLowerCase();

  if (feeScript === depositScript) {
    throw new UnsafeTransactionError(
      'endereço de taxa igual ao de depósito — a cotação do provider está inconsistente',
    );
  }

  const feeOutputs = outputs.filter((o) => o.scriptHex.toLowerCase() === feeScript);
  const depositOutputs = outputs.filter((o) => o.scriptHex.toLowerCase() === depositScript);

  // --- A saída de taxa: onde o dinheiro se perde se estiver errada ---------

  if (feeOutputs.length === 0) {
    throw new UnsafeTransactionError('a saída de taxa exigida pelo operador não foi incluída', {
      feeScriptHex: feeScript,
    });
  }
  if (feeOutputs.length > 1) {
    throw new UnsafeTransactionError(
      `há ${feeOutputs.length} saídas para o endereço de taxa; o operador espera exatamente uma`,
    );
  }

  const fee = feeOutputs[0]!;

  if (!fee.isExplicit) {
    // O caso que o provider documenta como perda de fundos.
    throw new UnsafeTransactionError(
      'a saída de taxa está BLINDADA. O operador exige saída explícita, e transmitir ' +
        'assim faz a operação falhar podendo perder os fundos',
      { feeScriptHex: feeScript },
    );
  }

  if (fee.assetId === null) {
    throw new UnsafeTransactionError(
      'não foi possível determinar o ativo da saída de taxa — sem certeza, não se transmite',
    );
  }
  if (fee.assetId.toLowerCase() !== expectedAsset) {
    throw new UnsafeTransactionError(
      `a saída de taxa está em outro ativo (${fee.assetId}); o operador espera ${expectedAsset}`,
      { got: fee.assetId, expected: expectedAsset },
    );
  }

  if (fee.amount === null) {
    throw new UnsafeTransactionError('não foi possível determinar o valor da saída de taxa');
  }
  if (fee.amount !== expectation.feeAmount) {
    throw new UnsafeTransactionError(
      `valor da taxa não confere: ${fee.amount} em vez de ${expectation.feeAmount}`,
      { got: fee.amount.toString(), expected: expectation.feeAmount.toString() },
    );
  }

  // --- A saída principal ----------------------------------------------------

  if (depositOutputs.length === 0) {
    throw new UnsafeTransactionError('a saída para o endereço do operador não foi incluída', {
      depositScriptHex: depositScript,
    });
  }
  if (depositOutputs.length > 1) {
    throw new UnsafeTransactionError(
      `há ${depositOutputs.length} saídas para o endereço do operador; esperava uma`,
    );
  }

  const deposit = depositOutputs[0]!;
  if (deposit.assetId !== null && deposit.assetId.toLowerCase() !== expectedAsset) {
    throw new UnsafeTransactionError(
      `a saída principal está em outro ativo (${deposit.assetId}); esperava ${expectedAsset}`,
    );
  }

  // --- Privacidade ----------------------------------------------------------
  // Na Liquid, saída explícita revela valor e ativo. Só a taxa precisa ser
  // explícita; qualquer outra vazando é bug de construção, e o usuário não
  // pediu para publicar o valor da operação dele.
  const outrasExplicitas = outputs.filter(
    (o) => o.isExplicit && o.scriptHex.toLowerCase() !== feeScript && !isFeeOutput(o),
  );
  if (outrasExplicitas.length > 0) {
    throw new UnsafeTransactionError(
      `${outrasExplicitas.length} saída(s) além da taxa estão explícitas, expondo valores na cadeia`,
      { scripts: outrasExplicitas.map((o) => o.scriptHex.slice(0, 16)) },
    );
  }
}

/**
 * A taxa de rede da Liquid é uma saída sem script, sempre explícita e sempre
 * em L-BTC. Ela não conta como vazamento de privacidade — é assim que a rede
 * funciona.
 */
function isFeeOutput(output: OutputShape): boolean {
  return output.scriptHex === '';
}

/**
 * Valida um envio simples DePix → DePix.
 *
 * Aqui não há saída explícita legítima: tudo deve ser confidencial, exceto a
 * taxa de rede.
 */
export function assertTransferOutputs(
  outputs: readonly OutputShape[],
  expectation: { destinationScriptHex: string; assetId: string },
): void {
  const destScript = expectation.destinationScriptHex.toLowerCase();
  const expectedAsset = expectation.assetId.toLowerCase();

  const dest = outputs.filter((o) => o.scriptHex.toLowerCase() === destScript);
  if (dest.length === 0) {
    throw new UnsafeTransactionError('a saída para o endereço de destino não foi incluída');
  }
  if (dest.length > 1) {
    throw new UnsafeTransactionError(`há ${dest.length} saídas para o destino; esperava uma`);
  }

  const destination = dest[0]!;
  if (destination.assetId !== null && destination.assetId.toLowerCase() !== expectedAsset) {
    throw new UnsafeTransactionError(
      `a saída de destino está em outro ativo (${destination.assetId}); esperava ${expectedAsset}`,
    );
  }

  const explicitas = outputs.filter((o) => o.isExplicit && !isFeeOutput(o));
  if (explicitas.length > 0) {
    throw new UnsafeTransactionError(
      `${explicitas.length} saída(s) explícitas num envio simples — tudo deveria ser confidencial`,
      { scripts: explicitas.map((o) => o.scriptHex.slice(0, 16)) },
    );
  }
}
