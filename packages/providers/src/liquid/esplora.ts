/**
 * Leitura da Liquid Network via Esplora (Blockstream).
 *
 * Endpoint verificado durante o discovery:
 *   https://blockstream.info/liquid/api
 *
 * É read-only por design nesta etapa. A construção e a assinatura de
 * transações acontecem no dispositivo do usuário (LWK); o servidor observa
 * a rede para detectar depósitos, contar confirmações e conciliar.
 *
 * ⚠️ Limite inerente das Confidential Transactions: o Esplora sozinho não
 * revela valores nem assets de saídas blindadas. Detectar o valor de um
 * depósito exige desblindar com a master blinding key — o que acontece com
 * o descriptor watch-only, fora deste módulo.
 */

import { ProviderError } from '@depix/core';

import type { LiquidProvider, LiquidTxStatus, ProviderInfo } from '../types.ts';

export interface EsploraConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://blockstream.info/liquid/api';

export class EsploraLiquidProvider implements LiquidProvider {
  readonly info: ProviderInfo = {
    code: 'esplora',
    environment: 'production',
    // Ler a blockchain pública não movimenta fundos.
    handlesRealFunds: false,
  };

  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: EsploraConfig = {}) {
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async getTransaction(txid: string): Promise<LiquidTxStatus | null> {
    assertTxid(txid);
    const tx = await this.#get<{
      txid: string;
      status?: { confirmed?: boolean; block_height?: number };
    }>(`/tx/${txid}`, { allow404: true });

    if (!tx) return null;

    const confirmed = tx.status?.confirmed === true;
    const blockHeight = tx.status?.block_height;

    let confirmations = 0;
    if (confirmed && typeof blockHeight === 'number') {
      const tip = await this.getTipHeight();
      confirmations = Math.max(0, tip - blockHeight + 1);
    }

    return { txid: tx.txid, confirmed, confirmations, blockHeight };
  }

  async getTipHeight(): Promise<number> {
    const height = await this.#get<number>('/blocks/tip/height');
    if (typeof height !== 'number' || !Number.isFinite(height)) {
      throw new ProviderError('unexpected_response_shape', 'Altura da ponta da cadeia inválida', {
        retryable: true,
        raw: height,
      });
    }
    return height;
  }

  /**
   * Metadados on-chain do ativo.
   *
   * Usado para confirmar que o asset ID configurado é mesmo o DePix — a
   * verificação que impede creditar uma falsificação com o mesmo ticker.
   */
  async getAssetInfo(liquidAssetId: string): Promise<{ ticker?: string; precision?: number } | null> {
    if (!/^[0-9a-f]{64}$/i.test(liquidAssetId)) {
      throw new ProviderError('invalid_asset_id', 'Asset ID precisa ter 64 caracteres hexadecimais', {
        retryable: false,
      });
    }
    const info = await this.#get<{
      contract?: { ticker?: string; precision?: number; name?: string };
      ticker?: string;
      precision?: number;
    }>(`/asset/${liquidAssetId.toLowerCase()}`, { allow404: true });

    if (!info) return null;
    return {
      ticker: info.contract?.ticker ?? info.ticker,
      precision: info.contract?.precision ?? info.precision,
    };
  }

  async broadcast(signedTxHex: string): Promise<string> {
    if (!/^[0-9a-f]+$/i.test(signedTxHex) || signedTxHex.length < 20) {
      throw new ProviderError('invalid_tx_hex', 'Transação assinada inválida', { retryable: false });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: signedTxHex,
        signal: controller.signal,
      });
      const text = (await response.text()).trim();

      if (!response.ok) {
        throw new ProviderError('broadcast_rejected', `Rede recusou a transação: ${text.slice(0, 300)}`, {
          retryable: false,
          httpStatus: response.status,
        });
      }
      assertTxid(text);
      return text;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network_error', `Falha ao transmitir: ${String(err)}`, {
        retryable: true,
        raw: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #get<T>(path: string, opts: { allow404?: boolean } = {}): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 404 && opts.allow404) return null;

      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError('esplora_error', `HTTP ${response.status} em ${path}`, {
          retryable: response.status >= 500 || response.status === 429,
          httpStatus: response.status,
          raw: text.slice(0, 300),
        });
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        // /blocks/tip/height devolve número puro, não JSON estrito.
        const asNumber = Number(text);
        if (Number.isFinite(asNumber)) return asNumber as T;
        throw new ProviderError('invalid_json', `Resposta ilegível de ${path}`, { retryable: true });
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network_error', `Falha de rede em ${path}: ${String(err)}`, {
        retryable: true,
        raw: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertTxid(txid: string): void {
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    throw new ProviderError('invalid_txid', `TXID inválido: "${txid.slice(0, 20)}"`, { retryable: false });
  }
}
