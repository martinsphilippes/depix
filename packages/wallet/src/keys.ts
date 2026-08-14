/**
 * Chaves — **executa exclusivamente no dispositivo do usuário**.
 *
 * Este módulo é a fronteira da autocustódia. Nada aqui pode ser importado
 * pelo servidor, e este pacote não depende de `@depix/firestore` justamente
 * para que essa fronteira seja verificável por inspeção de dependências, não
 * só por disciplina.
 *
 * O que sai daqui e pode ir para o servidor:
 *   • o **descriptor CT watch-only** — permite ver saldo e detectar
 *     depósitos, e é insuficiente para gastar.
 *
 * O que NUNCA sai daqui:
 *   • o mnemônico;
 *   • a chave privada;
 *   • qualquer material de assinatura.
 *
 * A assinatura acontece neste processo, contra a chave que vive neste
 * processo. Não existe endpoint de assinatura remota, e o servidor não tem
 * como produzir uma transação assinada nem que queira.
 */

import { Mnemonic, Network, Signer, Wollet, WolletDescriptor } from 'lwk_wasm';

import { DomainError } from '@depix/core/browser';

export type NetworkName = 'mainnet' | 'testnet';

export function networkOf(name: NetworkName): Network {
  return name === 'mainnet' ? Network.mainnet() : Network.testnet();
}

/**
 * Gera um mnemônico novo.
 *
 * 12 palavras por padrão. O valor devolvido é o segredo do usuário: quem o
 * tiver controla os fundos. Ele não deve ser logado, enviado, telemetrado
 * nem persistido fora do controle do usuário.
 */
export function generateMnemonic(wordCount: 12 | 24 = 12): string {
  return Mnemonic.fromRandom(wordCount).toString();
}

/**
 * Valida um mnemônico sem revelá-lo.
 *
 * Devolve booleano em vez de lançar com a frase na mensagem — mensagem de
 * erro tem o hábito de acabar em log.
 */
export function isValidMnemonic(phrase: string): boolean {
  try {
    new Mnemonic(phrase.trim());
    return true;
  } catch {
    return false;
  }
}

export interface WalletIdentity {
  /** Descriptor CT watch-only. É o único artefato que pode ir ao servidor. */
  readonly ctDescriptor: string;
  /** Impressão digital da chave mestra — identificador estável, não secreto. */
  readonly fingerprint: string;
  readonly network: NetworkName;
}

/**
 * Deriva a identidade pública da carteira a partir do mnemônico.
 *
 * Usa `wpkhSlip77Descriptor`: single-sig P2WPKH com blinding key derivada por
 * SLIP-77 — o padrão do LWK, e o que faz cada endereço ter blinding key
 * própria a partir de uma única semente.
 */
export function deriveIdentity(mnemonicPhrase: string, network: NetworkName): WalletIdentity {
  const phrase = mnemonicPhrase.trim();
  if (!isValidMnemonic(phrase)) {
    throw new DomainError('invalid_mnemonic', 'Frase de recuperação inválida');
  }

  const net = networkOf(network);
  const signer = new Signer(new Mnemonic(phrase), net);

  return {
    ctDescriptor: signer.wpkhSlip77Descriptor().toString(),
    fingerprint: signer.fingerprint(),
    network,
  };
}

/**
 * Cria um signer.
 *
 * ⚠️ O objeto devolvido **contém material de chave**. Ele não deve ser
 * guardado em variável de módulo, colocado em estado global de UI, nem
 * mantido vivo além da operação de assinatura. O padrão é: criar, assinar,
 * descartar.
 */
export function createSigner(mnemonicPhrase: string, network: NetworkName): Signer {
  const phrase = mnemonicPhrase.trim();
  if (!isValidMnemonic(phrase)) {
    throw new DomainError('invalid_mnemonic', 'Frase de recuperação inválida');
  }
  return new Signer(new Mnemonic(phrase), networkOf(network));
}

/** Carteira watch-only a partir do descriptor. Vê, não gasta. */
export function openWatchOnly(ctDescriptor: string, network: NetworkName): Wollet {
  let descriptor: WolletDescriptor;
  try {
    descriptor = new WolletDescriptor(ctDescriptor);
  } catch (err) {
    throw new DomainError('invalid_descriptor', `Descriptor inválido: ${String(err).slice(0, 120)}`);
  }

  const net = networkOf(network);
  if (descriptor.isMainnet() !== (network === 'mainnet')) {
    throw new DomainError(
      'descriptor_network_mismatch',
      `Descriptor é de ${descriptor.isMainnet() ? 'mainnet' : 'testnet'}, mas a rede pedida é ${network}`,
    );
  }

  return new Wollet(net, descriptor);
}

/**
 * Confere que um descriptor corresponde ao mnemônico.
 *
 * Usado no fluxo de recuperação: antes de restaurar uma carteira, confirma
 * que a frase digitada é mesmo a daquela carteira — em vez de abrir uma
 * carteira vazia diferente e deixar o usuário achar que perdeu o dinheiro.
 */
export function descriptorMatchesMnemonic(
  ctDescriptor: string,
  mnemonicPhrase: string,
  network: NetworkName,
): boolean {
  try {
    return deriveIdentity(mnemonicPhrase, network).ctDescriptor === ctDescriptor.trim();
  } catch {
    return false;
  }
}
