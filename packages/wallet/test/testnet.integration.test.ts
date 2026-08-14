/**
 * Envio de verdade, contra a Liquid testnet.
 *
 * Todo o resto da suíte roda offline e prova propriedades do código. Este
 * arquivo prova outra coisa, que nenhum teste offline consegue: que a
 * transação que montamos é **aceita pela rede**. Um PSET malformado, uma
 * saída blindada onde não devia, um witness incompleto — nada disso aparece
 * num teste com UTXO sintético; aparece aqui, na forma de rejeição.
 *
 * ## Por que é opt-in
 *
 * Depende de rede externa e de faucet, e portanto é lento e pode falhar por
 * motivos que não são culpa do código. Rodar por padrão tornaria a suíte
 * instável, e uma suíte instável é uma suíte que as pessoas aprendem a
 * ignorar. Habilite explicitamente:
 *
 *     LIQUID_TESTNET_E2E=yes node --test --experimental-strip-types \
 *       packages/wallet/test/testnet.integration.test.ts
 *
 * Sem a variável, os testes são pulados — não silenciosamente aprovados.
 *
 * ## Por que testnet e não DePix
 *
 * O DePix é emitido na mainnet e não tem equivalente na testnet. O ativo de
 * teste do faucet exercita exatamente o mesmo caminho: envio de um ativo
 * Liquid específico, com troco e taxa em L-BTC. O que muda é o identificador
 * do ativo, que é parâmetro — e por isso o teste cai para L-BTC quando o
 * faucet do ativo emitido está vazio, em vez de falhar por culpa alheia.
 *
 * ⚠️ Este teste move fundos — de testnet, sem valor. Ele nunca deve ser
 * apontado para mainnet: `executeSend` usa a rede gravada no cofre, e o cofre
 * aqui é sempre criado como testnet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Network, Wollet, WolletDescriptor } from 'lwk_wasm';

import { type SendStage, deriveIdentity, executeSend, generateMnemonic, sealVault } from '../src/index.ts';

const ENABLED = process.env['LIQUID_TESTNET_E2E'] === 'yes';
const ESPLORA = 'https://blockstream.info/liquidtestnet/api';
const FAUCET = 'https://liquidtestnet.com/api/faucet';
const PIN = 'pin-de-teste-testnet';

/** Ativo de teste do faucet do liquidtestnet.com. */
const TEST_ASSET = '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5';
/** L-BTC da testnet — o ativo de política, sempre disponível. */
const TESTNET_LBTC = '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49';

/**
 * Pede fundos ao faucet.
 *
 * `lbtc` paga a taxa da rede; `test` é um ativo emitido, mais parecido com o
 * DePix. Devolve `null` quando o faucet recusa — ele é um serviço de terceiro
 * e às vezes fica sem fundos para a própria taxa. Distinguir "o faucet está
 * vazio" de "nosso código está errado" importa: só o segundo é motivo para
 * falhar o teste.
 */
async function faucet(address: string, action: 'lbtc' | 'test'): Promise<string | null> {
  const url = `${FAUCET}?address=${encodeURIComponent(address)}&action=${action}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;

  const body = (await response.json()) as { txid?: string; error?: string };
  return body.txid ?? null;
}

/** Espera a transação do faucet aparecer no explorador. */
async function waitForTx(txid: string, timeoutMs = 120_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const r = await fetch(`${ESPLORA}/tx/${txid}`, { signal: AbortSignal.timeout(20_000) });
    if (r.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`transação ${txid} não apareceu no explorador em ${timeoutMs} ms`);
}

function addressOf(mnemonic: string): string {
  const identity = deriveIdentity(mnemonic, 'testnet');
  const wollet = new Wollet(Network.testnet(), new WolletDescriptor(identity.ctDescriptor));
  return wollet.address(0).address().toString();
}

describe('envio real na Liquid testnet', { skip: !ENABLED && 'defina LIQUID_TESTNET_E2E=yes' }, () => {
  it(
    'monta, assina e transmite — e o destinatário recebe o valor exato',
    { timeout: 600_000 },
    async () => {
      const origemMnemonic = generateMnemonic(12);
      const destinoMnemonic = generateMnemonic(12);

      const origem = deriveIdentity(origemMnemonic, 'testnet');
      const enderecoOrigem = addressOf(origemMnemonic);
      const enderecoDestino = addressOf(destinoMnemonic);

      // 1. Financia a carteira de origem. O L-BTC é obrigatório — sem ele não
      //    há como pagar a taxa e nada pode ser testado.
      const txLbtc = await faucet(enderecoOrigem, 'lbtc');
      assert.ok(txLbtc, 'o faucet não entregou L-BTC; sem taxa não há transação a testar');
      await waitForTx(txLbtc);

      // O ativo emitido é o cenário mais próximo do DePix, mas o faucet dele
      // vive vazio. Quando falta, transferimos L-BTC: o caminho exercitado é
      // o mesmo — montar, validar, assinar, transmitir — e o que muda é o
      // identificador do ativo, que é parâmetro.
      const txAtivo = await faucet(enderecoOrigem, 'test');
      let ativo = TESTNET_LBTC;
      if (txAtivo) {
        await waitForTx(txAtivo);
        ativo = TEST_ASSET;
      } else {
        console.log('faucet do ativo de teste indisponível — transferindo L-BTC');
      }

      // 2. Cofre igual ao que o navegador grava — inclusive o PIN.
      const vault = await sealVault({
        mnemonic: origemMnemonic,
        pin: PIN,
        fingerprint: origem.fingerprint,
        ctDescriptor: origem.ctDescriptor,
        network: 'testnet',
      });

      // 3. O envio, pelo mesmo caminho que a tela chama.
      const etapas: SendStage[] = [];
      const resultado = await executeSend({
        vault,
        pin: PIN,
        destinationAddress: enderecoDestino,
        amount: 100n,
        assetId: ativo,
        esploraUrl: ESPLORA,
        onStage: (s) => etapas.push(s),
      });

      assert.deepEqual(etapas, [
        'unlocking',
        'syncing',
        'building',
        'signing',
        'broadcasting',
        'done',
      ]);
      assert.match(resultado.txid, /^[0-9a-f]{64}$/);
      assert.equal(resultado.network, 'testnet');

      // 4. A rede aceitou de fato — não basta o broadcast ter retornado.
      await waitForTx(resultado.txid);

      // 5. O destinatário recebe exatamente o que foi enviado. É aqui que um
      //    erro de blinding ou de ativo apareceria: a transação seria válida
      //    e o valor, outro.
      const destinoIdent = deriveIdentity(destinoMnemonic, 'testnet');
      const destinoWollet = new Wollet(
        Network.testnet(),
        new WolletDescriptor(destinoIdent.ctDescriptor),
      );
      const { createChainClient, syncWallet } = await import('../src/chain.ts');
      await syncWallet(
        destinoWollet,
        createChainClient({ network: 'testnet', baseUrl: ESPLORA }),
      );

      // `balance()` devolve um `Balance`, não um Map: os valores saem por
      // `entries()`. Chamar `.get()` direto lança TypeError.
      const saldo = destinoWollet.balance().entries() as Map<string, bigint>;
      assert.equal(
        String(saldo.get(ativo) ?? 0n),
        '100',
        'o destinatário não recebeu exatamente o valor enviado',
      );
    },
  );
});
