/**
 * Cliente Firestore.
 *
 * Duas configurações não são negociáveis:
 *
 *  1. `useBigInt: true` — sem isso, o SDK devolve inteiros como `number`
 *     (IEEE 754 double) e qualquer valor acima de 2^53 perde precisão
 *     silenciosamente. Num sistema financeiro isso é inaceitável, e é
 *     exatamente o que a regra "dinheiro nunca é float" existe para
 *     impedir. Verificado contra o emulador: com a flag ligada, o
 *     round-trip de 9223372036854775807n é exato.
 *
 *  2. `ignoreUndefinedProperties: false` — gravar `undefined` por engano
 *     apagaria um campo. Preferimos a exceção.
 */

import { Firestore, type Settings } from '@google-cloud/firestore';

import { DomainError } from '@depix/core';

/** Limite do inteiro de 64 bits do Firestore. */
export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

/**
 * Guarda contra estouro silencioso.
 *
 * O Firestore armazena inteiros em 64 bits. Um valor acima disso não gera
 * erro do lado do SDK — ele simplesmente não cabe. Como toda quantia aqui é
 * `bigint`, que não tem teto, a checagem precisa ser explícita.
 */
export function assertFitsInt64(value: bigint, field: string): void {
  if (value > INT64_MAX || value < INT64_MIN) {
    throw new DomainError(
      'amount_out_of_range',
      `Valor de "${field}" não cabe em 64 bits: ${value}`,
      { field, value: value.toString() },
    );
  }
}

/**
 * Normaliza um inteiro lido do Firestore para `number`.
 *
 * ⚠️ Consequência de `useBigInt: true` que é fácil de esquecer: a flag é
 * global, então **todo** inteiro volta como `bigint` — inclusive os que não
 * são dinheiro, como `decimals`, `vout`, `confirmations` e `seq`. Isso
 * quebra duas coisas de forma silenciosa:
 *
 *   • aritmética misturada (`seq + 1` com `seq` bigint lança TypeError);
 *   • `JSON.stringify`, que lança em bigint — ou seja, um contador lido do
 *     banco e devolvido numa resposta HTTP derruba a requisição.
 *
 * Por isso todo contador lido do Firestore passa por aqui, e dinheiro nunca
 * passa: quantia continua `bigint` do começo ao fim.
 */
export function asNumber(value: unknown, field = 'valor'): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new DomainError(
        'unsafe_number_conversion',
        `"${field}" não cabe em number sem perder precisão: ${value}. ` +
          'Se isto é uma quantia, mantenha como bigint.',
        { field, value: value.toString() },
      );
    }
    return Number(value);
  }
  throw new DomainError('unexpected_number_type', `"${field}" não é numérico: ${typeof value}`, {
    field,
  });
}

/** Idem, aceitando ausência. */
export function asNumberOrNull(value: unknown, field = 'valor'): number | null {
  return value === null || value === undefined ? null : asNumber(value, field);
}

/** Normaliza um inteiro lido do Firestore para `bigint` (quantias). */
export function asBigInt(value: unknown, field = 'valor'): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new DomainError(
        'amount_not_integer',
        `"${field}" veio como não inteiro (${value}) — indica quantia gravada como float`,
        { field },
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DomainError('unexpected_amount_type', `"${field}" não é uma quantia: ${typeof value}`, {
    field,
  });
}

export interface FirestoreConfig {
  readonly projectId: string;
  /** Host do emulador, ex.: "127.0.0.1:8080". Ausente = produção. */
  readonly emulatorHost?: string;
  readonly databaseId?: string;
  readonly credentials?: Settings['credentials'];
}

export function createFirestore(config: FirestoreConfig): Firestore {
  if (config.emulatorHost) {
    // O SDK lê esta variável; definir aqui mantém o call site declarativo.
    process.env['FIRESTORE_EMULATOR_HOST'] = config.emulatorHost;
  }

  const settings: Settings = {
    projectId: config.projectId,
    useBigInt: true,
    ignoreUndefinedProperties: false,
  };
  if (config.databaseId) settings.databaseId = config.databaseId;
  if (config.credentials) settings.credentials = config.credentials;

  return new Firestore(settings);
}

/**
 * `true` quando o cliente está apontado para um emulador.
 *
 * Usado pelo gate de ambiente: produção com emulador (ou desenvolvimento
 * apontado para o projeto real) é erro de configuração com consequência
 * financeira.
 */
export function isEmulated(): boolean {
  return Boolean(process.env['FIRESTORE_EMULATOR_HOST']);
}

/** Código de erro do Firestore para "documento já existe". */
export const ALREADY_EXISTS = 6;
export const NOT_FOUND = 5;
export const ABORTED = 10;
export const FAILED_PRECONDITION = 9;

export function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === ALREADY_EXISTS;
}

export function isAborted(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === ABORTED;
}

/**
 * Normaliza data lida do Firestore.
 *
 * O SDK devolve `Timestamp`, não `Date` — e `Timestamp` não tem `getTime()`.
 * Passar um direto para código que espera `Date` não dá erro de tipo (os
 * documentos são declarados com `Date`) e explode em tempo de execução, o
 * que já aconteceu: a política de segurança quebrava ao comparar a data de
 * alteração de um contato.
 *
 * Esta função existia copiada em oito arquivos. Uma cópia é conveniência;
 * oito é a garantia de que a nona sairá errada.
 */
export function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}
