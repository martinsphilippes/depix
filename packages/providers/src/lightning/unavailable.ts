/**
 * LightningProvider — INTEGRAÇÃO PENDENTE.
 *
 * Não existe caminho para transportar DePix por Lightning hoje:
 *
 *   • DePix é ativo emitido na **Liquid Network**;
 *   • Taproot Assets emite e roteia ativos no **Bitcoin mainnet**;
 *   • são protocolos distintos em cadeias distintas, sem ponte documentada;
 *   • Boltz suporta apenas BTC, L-BTC e ARK (verificado ao vivo na API);
 *   • o Breez SDK Nodeless documenta que saldo em ativo não-BTC **não**
 *     paga invoice Lightning em BTC.
 *
 * Uma página de glossário de terceiros afirma que DePix estaria disponível
 * "através do ecossistema" Taproot Assets. Não confirmado: a documentação
 * oficial do DePix não menciona Lightning, e o registro on-chain mostra
 * emissão na Liquid. Ver ARCHITECTURE.md §5.
 *
 * Esta classe existe para que o resto do sistema já dependa da interface.
 * Ela falha de forma explícita em vez de simular — se um dia a integração
 * existir, troca-se a implementação e nada acima muda.
 */

import { IntegrationPendingError, type Money } from '@depix/core';

import type { LightningProvider, ProviderInfo } from '../types.ts';

const PENDING_ON =
  'não existe ponte entre DePix (Liquid) e Lightning/Taproot Assets (Bitcoin mainnet). ' +
  'Um caminho composto LN→L-BTC (Boltz) →DePix (SideSwap) é tecnicamente possível, mas ' +
  'expõe o usuário ao preço do BTC entre as pernas — decisão de produto, não de engenharia.';

export class UnavailableLightningProvider implements LightningProvider {
  readonly info: ProviderInfo = {
    code: 'lightning_pending',
    environment: 'development',
    handlesRealFunds: false,
  };

  async createInvoice(_params: { amount: Money; description: string }): Promise<never> {
    throw new IntegrationPendingError('receber DePix via Lightning', PENDING_ON);
  }

  async payInvoice(_params: { invoice: string; maxFee: Money }): Promise<never> {
    throw new IntegrationPendingError('pagar invoice Lightning com DePix', PENDING_ON);
  }

  async getPayment(_paymentHash: string): Promise<never> {
    throw new IntegrationPendingError('consultar pagamento Lightning', PENDING_ON);
  }
}

/** Motivo legível para a UI, sem jargão. */
export const LIGHTNING_UNAVAILABLE_MESSAGE =
  'Lightning ainda não está disponível para DePix. O DePix funciona na rede Liquid, ' +
  'e ainda não existe uma ponte segura entre as duas redes.';
