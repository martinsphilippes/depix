/**
 * Acesso à Liquid a partir do dispositivo.
 *
 * O servidor também observa a cadeia (`packages/providers/liquid/esplora.ts`),
 * mas para outra coisa: ele conta confirmações e concilia. Aqui o objetivo é
 * diferente e não pode ser terceirizado — para montar uma transação é preciso
 * conhecer os UTXOs, e conhecê-los exige desblindar com a chave do usuário.
 * Por isso o scan roda no dispositivo, não no backend.
 *
 * A transmissão também sai daqui, e isso é deliberado: a transação assinada
 * vai do dispositivo direto para a rede, sem passar pelo nosso servidor. O
 * servidor fica sabendo do envio depois, pelo txid — e mesmo que não ficasse,
 * o dinheiro já teria andado. É o que "non-custodial" significa na prática.
 */

import { EsploraClient, type Pset, type Wollet } from 'lwk_wasm';

import { ProviderError } from '@depix/core/browser';

import { type NetworkName, networkOf } from './keys.ts';

/**
 * Endpoints públicos do Blockstream, verificados no discovery.
 *
 * São um ponto de centralização assumido: o Esplora vê quais endereços
 * consultamos. Ele **não** vê valores (as saídas são confidenciais) nem
 * consegue gastar. Trocar por um Esplora próprio é configuração, não
 * mudança de código.
 */
const ESPLORA_URL: Record<NetworkName, string> = {
  mainnet: 'https://blockstream.info/liquid/api',
  testnet: 'https://blockstream.info/liquidtestnet/api',
};

export interface ChainConfig {
  readonly network: NetworkName;
  readonly baseUrl?: string;
  /** Requisições paralelas no scan. Mais alto = mais rápido e mais agressivo. */
  readonly concurrency?: number;
}

export function createChainClient(config: ChainConfig): EsploraClient {
  return new EsploraClient(
    networkOf(config.network),
    config.baseUrl ?? ESPLORA_URL[config.network],
    // waterfalls: o servidor de índice acelerado exigiria enviar o descriptor
    // (ainda que cifrado) a um terceiro. Não vale a troca.
    false,
    config.concurrency ?? 4,
    // utxo_only=false: queremos o histórico, não só o gastável, para que o
    // extrato local case com o do servidor.
    false,
  );
}

/**
 * Sincroniza a carteira com a cadeia.
 *
 * Sem isto, `txBuilder().finish(wollet)` não encontra UTXO e falha com uma
 * mensagem de saldo insuficiente que seria mentira — o dinheiro está lá, a
 * carteira é que ainda não olhou.
 */
export async function syncWallet(
  wollet: Wollet,
  client: EsploraClient,
): Promise<{ synced: boolean }> {
  let update;
  try {
    update = await client.fullScan(wollet);
  } catch (err) {
    throw new ProviderError(
      'esplora',
      `Não foi possível consultar a rede Liquid: ${String(err).slice(0, 140)}`,
      { retryable: true },
    );
  }

  // `undefined` significa "nada mudou desde o último scan", não erro.
  if (!update) return { synced: false };

  wollet.applyUpdate(update);
  return { synced: true };
}

/**
 * Transmite a transação assinada e devolve o txid.
 *
 * ⚠️ Ponto sem volta. A partir daqui o dinheiro andou, e nenhuma validação
 * posterior desfaz. Toda checagem — inclusive o guard de saídas — tem de ter
 * acontecido antes.
 */
export async function broadcast(pset: Pset, client: EsploraClient): Promise<string> {
  try {
    const txid = await client.broadcast(pset);
    return txid.toString();
  } catch (err) {
    // `retryable: false` de propósito: a recusa tanto pode ser rede fora do ar
    // (que se resolve tentando de novo) quanto transação inválida (que não se
    // resolve nunca), e daqui não dá para distinguir. Repetir automaticamente
    // uma transmissão é o tipo de automatismo que os requisitos §43 proíbem —
    // quem decide repetir é o usuário, vendo o erro.
    throw new ProviderError(
      'esplora',
      `A rede recusou a transação: ${String(err).slice(0, 140)}`,
      { retryable: false, raw: String(err).slice(0, 200) },
    );
  }
}
