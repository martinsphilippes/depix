/**
 * Envio completo, do cofre à rede.
 *
 * Este módulo existe para que a **ordem** das etapas seja código, e não
 * disciplina de quem escreve a tela. A sequência é:
 *
 *   destravar → sincronizar → montar → **validar** → assinar → finalizar →
 *   conferir → transmitir → descartar a chave
 *
 * Cada troca de ordem aqui tem uma consequência concreta:
 *
 *   • validar depois de assinar deixa no dispositivo uma transação inválida
 *     já assinada, que alguém pode transmitir por engano mais tarde;
 *   • transmitir antes de conferir a finalização produz uma rejeição da rede
 *     com mensagem críptica, e o usuário não sabe se o dinheiro foi ou não;
 *   • sincronizar depois de montar faz o builder não achar UTXO e reportar
 *     saldo insuficiente — mentira, o dinheiro está lá.
 *
 * A validação em si (o guard de saídas) mora em `guard.ts` e é chamada de
 * dentro de `buildTransfer`/`buildWithdrawal`, para que não haja caminho de
 * construção que a contorne.
 *
 * ## Sobre o material de chave
 *
 * O signer e a frase existem apenas dentro de `executeSend`, e o `finally`
 * libera o signer mesmo quando algo lança. É redução de janela, não
 * eliminação: enquanto a assinatura acontece, a chave está em memória, e
 * nenhuma disciplina de código muda isso. O que reduz o risco de verdade é a
 * CSP e o fato de esta função ser curta.
 */

import type { EsploraClient, Pset } from 'lwk_wasm';

import { DomainError } from '@depix/core/browser';

import { broadcast, createChainClient, syncWallet } from './chain.ts';
import { type NetworkName, createSigner, deriveIdentity, openWatchOnly } from './keys.ts';
import { type VaultBlob, openVault } from './vault.ts';
import { assertFinalized, buildTransfer, buildWithdrawal, signAndFinalize } from './transactions.ts';

/** Etapas reportadas à UI. O usuário precisa saber onde parou se falhar. */
export type SendStage =
  | 'unlocking'
  | 'syncing'
  | 'building'
  | 'signing'
  | 'broadcasting'
  | 'done';

export interface ExecuteSendParams {
  readonly vault: VaultBlob;
  readonly pin: string;
  readonly destinationAddress: string;
  readonly amount: bigint;
  /** Saque DePix → Pix: exige as duas saídas do operador. */
  readonly withdrawal?: {
    readonly feeAddress: string;
    readonly feeAmount: bigint;
  };
  readonly assetId?: string;
  readonly feeRate?: number;
  readonly esploraUrl?: string;
  readonly onStage?: (stage: SendStage) => void;
  /** Injetável para teste; por padrão fala com o Esplora público. */
  readonly client?: EsploraClient;
}

export interface SendResult {
  readonly txid: string;
  readonly network: NetworkName;
}

export async function executeSend(params: ExecuteSendParams): Promise<SendResult> {
  const network = params.vault.network;
  const stage = params.onStage ?? (() => {});

  stage('unlocking');
  const mnemonic = await openVault(params.vault, params.pin);

  // A carteira watch-only é derivada do cofre, não do que o servidor mandou.
  // Se o servidor tentasse trocar o descriptor, o endereço de troco seria de
  // outra pessoa — derivar localmente fecha essa porta.
  const identity = deriveIdentity(mnemonic, network);
  if (identity.fingerprint !== params.vault.fingerprint) {
    throw new DomainError(
      'vault_mismatch',
      'O cofre local não corresponde à carteira. Restaure com sua frase de recuperação.',
    );
  }

  const wollet = openWatchOnly(identity.ctDescriptor, network);
  const client =
    params.client ??
    createChainClient({
      network,
      ...(params.esploraUrl ? { baseUrl: params.esploraUrl } : {}),
    });

  stage('syncing');
  await syncWallet(wollet, client);

  stage('building');
  // `buildTransfer`/`buildWithdrawal` validam as saídas antes de devolver —
  // nada é assinado sem passar pelo guard.
  const pset: Pset = params.withdrawal
    ? buildWithdrawal({
        wollet,
        depositAddress: params.destinationAddress,
        depositAmount: params.amount,
        feeAddress: params.withdrawal.feeAddress,
        feeAmount: params.withdrawal.feeAmount,
        network,
        ...(params.assetId ? { assetId: params.assetId } : {}),
        ...(params.feeRate !== undefined ? { feeRate: params.feeRate } : {}),
      })
    : buildTransfer({
        wollet,
        destinationAddress: params.destinationAddress,
        amount: params.amount,
        network,
        ...(params.assetId ? { assetId: params.assetId } : {}),
        ...(params.feeRate !== undefined ? { feeRate: params.feeRate } : {}),
      });

  stage('signing');
  const signer = createSigner(mnemonic, network);
  let finalized: Pset;
  try {
    finalized = signAndFinalize(pset, signer, wollet);
  } finally {
    // Libera o material de chave do lado wasm mesmo se a assinatura falhou.
    signer.free();
  }

  assertFinalized(finalized);

  stage('broadcasting');
  const txid = await broadcast(finalized, client);

  stage('done');
  return { txid, network };
}
