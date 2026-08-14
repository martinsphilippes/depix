/**
 * Construção e assinatura de transações — **no dispositivo do usuário**.
 *
 * Detalhe do SDK que causa bug silencioso se ignorado: os métodos de
 * `TxBuilder` **consomem o receptor** (semântica de move do wasm-bindgen) e
 * devolvem um novo builder. Encadear sem reatribuir produz
 * "null pointer passed to rust" na chamada seguinte. Todas as chamadas aqui
 * reatribuem.
 *
 * O fluxo é sempre o mesmo, e a ordem importa:
 *
 *   montar → **validar** → assinar → finalizar → transmitir
 *
 * A validação vem antes da assinatura de propósito: uma transação inválida
 * assinada é uma transação que alguém pode transmitir por engano depois.
 */

import { Address, AssetId, type Pset, type Signer, type Wollet } from 'lwk_wasm';

import { DEPIX_LIQUID_ASSET_ID, DomainError } from '@depix/core';

import { type NetworkName, networkOf } from './keys.ts';
import {
  type OutputShape,
  assertTransferOutputs,
  assertWithdrawalOutputs,
} from './guard.ts';

/** Extrai as formas de saída de um PSET para a validação. */
export function extractOutputs(pset: Pset): OutputShape[] {
  return pset.outputs().map((output) => {
    const asset = output.asset();
    const amount = output.amount();
    return {
      scriptHex: bytesToHex(output.scriptPubkey().bytes()),
      // Sem blinder index, a saída é explícita: valor e ativo visíveis.
      isExplicit: output.blinderIndex() === undefined,
      assetId: asset ? asset.toString() : null,
      amount: amount ?? null,
    } satisfies OutputShape;
  });
}

/** Script em hex do endereço, para casar saídas com destinatários. */
export function scriptHexOf(address: string, network: NetworkName): string {
  return bytesToHex(parseAddress(address, network).scriptPubkey().bytes());
}

/**
 * Interpreta um endereço Liquid, confidencial ou não.
 *
 * ⚠️ Usa o construtor, **não** `Address.parse`. `Address.parse` recusa
 * endereço não-confidencial ("Expected a blinded address"), e o endereço de
 * taxa devolvido pelo operador é justamente não-confidencial (`ex1…`) — usar
 * `parse` aqui quebraria todo saque. Em troca, o construtor não valida a
 * rede, então a checagem é feita explicitamente logo abaixo.
 */
function parseAddress(address: string, network: NetworkName): Address {
  let parsed: Address;
  try {
    parsed = new Address(address.trim());
  } catch (err) {
    throw new DomainError(
      'invalid_liquid_address',
      `Endereço inválido para a rede ${network}: ${String(err).slice(0, 100)}`,
      { address: address.slice(0, 20) },
    );
  }

  // Enviar para a rede errada perde os fundos.
  if (parsed.isMainnet() !== (network === 'mainnet')) {
    throw new DomainError(
      'invalid_liquid_address',
      `Endereço inválido para a rede ${network}: pertence a ` +
        `${parsed.isMainnet() ? 'mainnet' : 'testnet'}`,
      { address: address.slice(0, 20) },
    );
  }

  return parsed;
}

export interface BuildTransferParams {
  readonly wollet: Wollet;
  readonly destinationAddress: string;
  readonly amount: bigint;
  readonly network: NetworkName;
  readonly assetId?: string;
  readonly feeRate?: number;
}

/**
 * Envio DePix → DePix.
 *
 * Tudo confidencial: numa transferência comum não há razão para expor valor
 * ou ativo na cadeia.
 */
export function buildTransfer(params: BuildTransferParams): Pset {
  const assetId = (params.assetId ?? DEPIX_LIQUID_ASSET_ID).toLowerCase();
  if (params.amount <= 0n) {
    throw new DomainError('invalid_amount', 'Valor do envio precisa ser positivo');
  }

  const destination = parseAddress(params.destinationAddress, params.network);
  if (!destination.isBlinded()) {
    // Endereço não-confidencial num envio comum expõe o usuário sem motivo.
    throw new DomainError(
      'unconfidential_destination',
      'O endereço de destino não é confidencial. Peça um endereço lq1… ao destinatário.',
    );
  }

  const net = networkOf(params.network);
  let builder = net.txBuilder();
  builder = builder.addRecipient(destination, params.amount, new AssetId(assetId));
  if (params.feeRate !== undefined) builder = builder.feeRate(params.feeRate);

  const pset = builder.finish(params.wollet);

  // Valida ANTES de assinar.
  assertTransferOutputs(extractOutputs(pset), {
    destinationScriptHex: scriptHexOf(params.destinationAddress, params.network),
    assetId,
  });

  return pset;
}

export interface BuildWithdrawalParams {
  readonly wollet: Wollet;
  /** Endereço do operador — recebe o principal, confidencial. */
  readonly depositAddress: string;
  readonly depositAmount: bigint;
  /** Endereço de taxa — recebe a taxa, EXPLÍCITA. */
  readonly feeAddress: string;
  readonly feeAmount: bigint;
  readonly network: NetworkName;
  readonly assetId?: string;
  readonly feeRate?: number;
}

/**
 * Saque DePix → Pix.
 *
 * A saída de taxa usa `addExplicitRecipient` — não-blindada, como o operador
 * exige. É o ponto do sistema em que errar custa os fundos do usuário, então
 * a transação montada é conferida saída por saída antes de qualquer
 * assinatura, e a validação aborta em vez de seguir.
 */
export function buildWithdrawal(params: BuildWithdrawalParams): Pset {
  const assetId = (params.assetId ?? DEPIX_LIQUID_ASSET_ID).toLowerCase();

  if (params.depositAmount <= 0n || params.feeAmount <= 0n) {
    throw new DomainError('invalid_amount', 'Valores do saque precisam ser positivos');
  }

  const deposit = parseAddress(params.depositAddress, params.network);
  const feeAddress = parseAddress(params.feeAddress, params.network);

  // O operador devolve o endereço de taxa em forma não-confidencial (`ex1…`).
  // Se vier confidencial, a saída correspondente sairia blindada — e é
  // exatamente esse o caso de perda de fundos. Melhor recusar aqui.
  const explicitFeeAddress = feeAddress.isBlinded() ? feeAddress.toUnconfidential() : feeAddress;

  const net = networkOf(params.network);
  let builder = net.txBuilder();
  builder = builder.addRecipient(deposit, params.depositAmount, new AssetId(assetId));
  builder = builder.addExplicitRecipient(explicitFeeAddress, params.feeAmount, new AssetId(assetId));
  if (params.feeRate !== undefined) builder = builder.feeRate(params.feeRate);

  const pset = builder.finish(params.wollet);

  // A conferência que impede a perda de fundos.
  assertWithdrawalOutputs(extractOutputs(pset), {
    depositScriptHex: scriptHexOf(params.depositAddress, params.network),
    feeScriptHex: bytesToHex(
      parseAddress(params.feeAddress, params.network).toUnconfidential().scriptPubkey().bytes(),
    ),
    feeAmount: params.feeAmount,
    assetId,
  });

  return pset;
}

/**
 * Assina e finaliza.
 *
 * O signer contém material de chave. Ele é criado pelo chamador para esta
 * operação e deve ser descartado depois — não guardado em estado de UI.
 */
export function signAndFinalize(pset: Pset, signer: Signer, wollet: Wollet): Pset {
  const signed = signer.sign(pset);
  return wollet.finalize(signed);
}

/**
 * Confere que a transação está assinada antes de transmitir.
 *
 * Transmitir um PSET não finalizado é rejeitado pela rede, mas a mensagem de
 * erro que volta é críptica. Falhar aqui, com contexto, é mais útil.
 */
export function assertFinalized(pset: Pset): void {
  try {
    pset.extractTx();
  } catch (err) {
    throw new DomainError(
      'pset_not_finalized',
      `Transação ainda não está pronta para transmissão: ${String(err).slice(0, 120)}`,
    );
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
