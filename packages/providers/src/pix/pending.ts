/**
 * PixProvider — INTEGRAÇÃO PENDENTE (consulta DICT).
 *
 * A seção 8 dos requisitos pede que, ao digitar a chave Pix, o sistema
 * mostre "Nome: João da Silva / Instituição: Banco X" antes de confirmar.
 *
 * Isso depende de consulta ao DICT, o diretório de chaves do Pix, acessível
 * apenas a instituições participantes do arranjo ou por meio delas. Nenhum
 * dos operadores DePix pesquisados expõe esse endpoint (PROVIDERS.md §3).
 *
 * O que fazemos enquanto não existe — e por que não é um contorno:
 *
 *   1. `refundAddress` é SEMPRE preenchido com endereço do próprio usuário.
 *      Chave inválida resulta em estorno, não em perda.
 *   2. A tela de revisão mostra a chave digitada em destaque e informa que
 *      a validação ocorre na liquidação. Interface honesta é melhor do que
 *      interface bonita com nome inventado.
 *
 * Inventar um nome de recebedor seria exatamente o tipo de simulação que a
 * regra 43 proíbe — e num fluxo de transferência de dinheiro, o dano de um
 * nome errado exibido com confiança é grande.
 */

import { IntegrationPendingError } from '@depix/core';

import type { PixProvider, ProviderInfo, RecipientInfo } from '../types.ts';

const PENDING_ON =
  'acesso ao DICT via instituição participante do arranjo Pix. ' +
  'Nenhum operador DePix expõe consulta de chave hoje.';

/** Tipos de chave Pix, detectáveis por formato sem consultar o diretório. */
export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | 'unknown';

/**
 * Classifica a chave pelo formato.
 *
 * Isto é validação **sintática**, não de existência: dizer "isto tem cara de
 * e-mail" é diferente de dizer "esta chave existe e pertence a alguém". A
 * UI precisa manter essa distinção clara para o usuário.
 */
export function detectPixKeyType(key: string): PixKeyType {
  const raw = key.trim();
  const digits = raw.replace(/\D/g, '');

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return 'random';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return 'email';
  if (/^\+?55\d{10,11}$/.test(digits) || (raw.startsWith('+') && digits.length >= 12)) return 'phone';
  if (digits.length === 11 && /^\d+$/.test(digits) && !raw.startsWith('+')) return 'cpf';
  if (digits.length === 14) return 'cnpj';
  return 'unknown';
}

/** Mascara para exibição e log. A chave completa não é persistida. */
export function maskPixKey(key: string): string {
  const raw = key.trim();
  const type = detectPixKeyType(raw);

  switch (type) {
    case 'email': {
      const [user = '', domain = ''] = raw.split('@');
      const head = user.slice(0, 2);
      return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
    }
    case 'cpf': {
      const d = raw.replace(/\D/g, '');
      return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
    }
    case 'cnpj': {
      const d = raw.replace(/\D/g, '');
      return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/****-**`;
    }
    case 'phone': {
      const d = raw.replace(/\D/g, '');
      return `+55 ****-${d.slice(-4)}`;
    }
    case 'random':
      return `${raw.slice(0, 8)}…${raw.slice(-4)}`;
    default:
      return raw.length <= 6 ? '***' : `${raw.slice(0, 3)}…${raw.slice(-2)}`;
  }
}

export class PendingPixProvider implements PixProvider {
  readonly info: ProviderInfo = {
    code: 'pix_pending',
    environment: 'development',
    handlesRealFunds: false,
  };

  /**
   * Validação sintática. Não confirma existência da chave — e o retorno
   * deixa isso explícito para quem consome.
   */
  async validatePixKey(pixKey: string): Promise<{ valid: boolean; keyType: string }> {
    const type = detectPixKeyType(pixKey);
    return { valid: type !== 'unknown', keyType: type };
  }

  async getRecipient(_pixKey: string): Promise<RecipientInfo> {
    throw new IntegrationPendingError('consultar nome e instituição do dono da chave Pix', PENDING_ON);
  }
}

/** Texto exibido na revisão, no lugar do nome que não temos. */
export const RECIPIENT_UNKNOWN_NOTICE =
  'Não é possível confirmar o nome do recebedor antes do envio. ' +
  'Confira a chave com atenção — se ela estiver incorreta, o valor será devolvido para a sua carteira.';
