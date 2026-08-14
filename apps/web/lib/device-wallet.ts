'use client';

/**
 * A carteira do dispositivo.
 *
 * Fronteira entre a interface e `@depix/wallet`. Tudo que envolve material de
 * chave passa por aqui, e a regra do módulo é curta: **a frase nunca vira
 * estado de React**.
 *
 * O motivo é concreto. Estado de componente sobrevive à operação, aparece no
 * React DevTools, entra em snapshot de erro e é serializado por ferramentas de
 * replay de sessão. O PIN entra como argumento de uma função assíncrona, é
 * usado para abrir o cofre, e a frase existe apenas dentro de `executeSend`.
 * Terminada a chamada, nada resta.
 *
 * Por isso não há aqui — e não deve haver — um `unlock()` que devolva a frase
 * e um `sign()` que a receba. A operação inteira é atômica de propósito: quem
 * quiser assinar entrega o PIN e recebe o txid.
 *
 * ## Por que o LWK entra por `await import()`
 *
 * `@depix/wallet` carrega o LWK, que é WebAssembly. Importá-lo no topo faria
 * o Next tentar carregá-lo durante a pré-renderização — no servidor, onde ele
 * não tem o que fazer — e o build quebra. Carregar sob demanda resolve isso e
 * ainda tira alguns megabytes do primeiro carregamento de quem só quer ver o
 * saldo.
 *
 * O cofre (`@depix/wallet/vault`) é exceção e entra estaticamente: é
 * WebCrypto puro, sem wasm, e precisa estar disponível para decidir se este
 * dispositivo já tem carteira.
 */

import { type VaultBlob, isVaultBlob, sealVault } from '@depix/wallet/vault';
import type { SendStage } from '@depix/wallet';

const STORAGE_KEY = 'depix.vault.v2';

/**
 * Rede do dispositivo.
 *
 * Testnet enquanto não houver liberação explícita de fundos reais — a mesma
 * postura do gate de ambiente do servidor (§34): mover dinheiro de verdade
 * exige intenção, nunca acontece por padrão.
 */
export const NETWORK: 'mainnet' | 'testnet' =
  process.env.NEXT_PUBLIC_LIQUID_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

export function loadVault(): VaultBlob | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    // Conteúdo de localStorage é escrevível por qualquer código da mesma
    // origem; validamos a forma antes de confiar.
    return isVaultBlob(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasWallet(): boolean {
  return loadVault() !== null;
}

export interface CreatedWallet {
  /**
   * ⚠️ As 12 palavras, em claro. Só existem para serem mostradas ao usuário
   * durante o backup e devem ser descartadas assim que ele confirmar. Não
   * persista, não logue, não envie.
   */
  readonly mnemonic: string;
  readonly ctDescriptor: string;
  readonly fingerprint: string;
}

/** Gera uma carteira nova. Nada é salvo ainda — só depois do backup. */
export async function createWallet(): Promise<CreatedWallet> {
  const { deriveIdentity, generateMnemonic } = await import('@depix/wallet');
  const mnemonic = generateMnemonic(12);
  const identity = deriveIdentity(mnemonic, NETWORK);
  return {
    mnemonic,
    ctDescriptor: identity.ctDescriptor,
    fingerprint: identity.fingerprint,
  };
}

/** Deriva a identidade de uma frase existente (fluxo de restauração). */
export async function identityOf(mnemonic: string): Promise<CreatedWallet> {
  const { deriveIdentity, isValidMnemonic } = await import('@depix/wallet');
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Frase de recuperação inválida. Confira as palavras e a ordem.');
  }
  const identity = deriveIdentity(mnemonic, NETWORK);
  return { mnemonic, ctDescriptor: identity.ctDescriptor, fingerprint: identity.fingerprint };
}

/**
 * Cifra a frase com o PIN e grava.
 *
 * Depois desta chamada o chamador deve descartar a frase que tinha em mãos —
 * ela não é devolvida, e recuperá-la exige o PIN.
 */
export async function persistWallet(wallet: CreatedWallet, pin: string): Promise<VaultBlob> {
  const blob = await sealVault({
    mnemonic: wallet.mnemonic,
    pin,
    fingerprint: wallet.fingerprint,
    ctDescriptor: wallet.ctDescriptor,
    network: NETWORK,
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  return blob;
}

/**
 * Endereço para receber, derivado aqui — nunca pedido ao servidor.
 *
 * Um endereço vindo do servidor permitiria a um servidor comprometido
 * redirecionar depósitos. Este vem do descriptor do próprio usuário, e por
 * isso não exige o PIN: receber dinheiro não deveria custar uma cerimônia.
 *
 * O índice é guardado localmente e avança a cada endereço gerado. Reusar
 * endereço não perde dinheiro, mas junta na cadeia pagamentos que não têm
 * por que estar juntos.
 */
export async function deviceAddress(opts: { fresh?: boolean } = {}): Promise<string> {
  const vault = loadVault();
  if (!vault) {
    throw new Error('Nenhuma carteira neste dispositivo. Crie ou restaure uma antes de receber.');
  }

  const proximo = Number(localStorage.getItem(INDEX_KEY) ?? '0');
  const indice = opts.fresh ? proximo + 1 : proximo;

  const { receiveAddress } = await import('@depix/wallet');
  const { address, index } = receiveAddress(vault.ctDescriptor, vault.network, indice);

  localStorage.setItem(INDEX_KEY, String(index));
  return address;
}

const INDEX_KEY = 'depix.receiveIndex.v1';

/**
 * Apaga o cofre deste navegador.
 *
 * Não apaga a carteira: os fundos vivem na Liquid, e a frase de recuperação
 * os traz de volta em qualquer dispositivo. Quem não anotou a frase, porém,
 * perde o acesso aqui — a UI precisa dizer isso antes de chamar.
 */
export function forgetWallet(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(INDEX_KEY);
}

/** QR de um texto, gerado no dispositivo — sem serviço externo nem dependência nova. */
export async function qrDataUri(text: string, pixelsPerModule = 6): Promise<string> {
  const { stringToQr } = await import('lwk_wasm');
  return stringToQr(text, pixelsPerModule);
}

export interface SignAndSendParams {
  readonly pin: string;
  readonly destinationAddress: string;
  /** Unidades mínimas de DePix (8 casas), como o servidor calculou. */
  readonly amount: bigint;
  readonly onStage?: (stage: SendStage) => void;
}

/**
 * Assina e transmite. É o único ponto do app que toca a chave privada.
 *
 * Devolve o txid. Registrar esse txid no servidor é responsabilidade do
 * chamador e acontece **depois** — a transação já está na rede a essa altura,
 * e nenhuma falha de API a desfaz.
 */
export async function signAndSend(params: SignAndSendParams): Promise<string> {
  const vault = loadVault();
  if (!vault) {
    throw new Error('Nenhuma carteira neste dispositivo. Crie ou restaure uma antes de enviar.');
  }

  const { executeSend } = await import('@depix/wallet');
  const result = await executeSend({
    vault,
    pin: params.pin,
    destinationAddress: params.destinationAddress,
    amount: params.amount,
    ...(params.onStage ? { onStage: params.onStage } : {}),
  });

  return result.txid;
}

/** Texto de cada etapa, para a tela não deixar o usuário no escuro. */
export const STAGE_LABEL: Record<SendStage, string> = {
  unlocking: 'Destravando a carteira…',
  syncing: 'Consultando a rede…',
  building: 'Montando e conferindo a transação…',
  signing: 'Assinando no seu dispositivo…',
  broadcasting: 'Transmitindo para a rede…',
  done: 'Enviado',
};
