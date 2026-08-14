import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrap } from '../src/bootstrap.ts';
import { COLLECTIONS, compositeId, idComponent, liquidTxId, webhookEventId } from '../src/paths.ts';
import { asNumber, assertFitsInt64, isAlreadyExists } from '../src/client.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';
import type { AssetDoc, LedgerAccountDoc } from '../src/types.ts';

let db: TestDb;

before(async () => {
  db = await createTestDb('model');
});
after(async () => {
  await db?.close();
});

describe('bootstrap', () => {
  it('cria ativos, contas de sistema, providers e taxas', async () => {
    const [assets, accounts, providers] = await Promise.all([
      db.collection(COLLECTIONS.assets).count().get(),
      db.collection(COLLECTIONS.ledgerAccounts).count().get(),
      db.collection(COLLECTIONS.providers).count().get(),
    ]);
    assert.equal(Number(assets.data().count), 3);
    assert.equal(Number(accounts.data().count), 18, '6 tipos de conta × 3 ativos');
    assert.ok(Number(providers.data().count) >= 6);
  });

  it('é idempotente: rodar de novo não duplica nem zera saldo', async () => {
    // Um bootstrap que sobrescrevesse contas apagaria saldos. Por isso ele usa
    // `create` e tolera ALREADY_EXISTS, em vez de `set`.
    const antes = await db.collection(COLLECTIONS.ledgerAccounts).count().get();
    const r = await bootstrap(db);
    const depois = await db.collection(COLLECTIONS.ledgerAccounts).count().get();

    assert.equal(r.accounts, 0, 'nenhuma conta nova');
    assert.equal(Number(antes.data().count), Number(depois.data().count));
  });

  it('grava o asset ID do DePix confirmado on-chain', async () => {
    const snap = await db.doc(`${COLLECTIONS.assets}/DEPIX`).get();
    const asset = snap.data() as AssetDoc;
    assert.equal(
      asset.liquidAssetId,
      '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189',
    );
    // `useBigInt` faz todo inteiro voltar como bigint, inclusive contadores
    // que não são dinheiro — daí a normalização explícita.
    assert.equal(asNumber(asset.decimals, 'decimals'), 8);
  });

  it('providers de produção vêm desabilitados', async () => {
    const snap = await db
      .collection(COLLECTIONS.providers)
      .where('environment', '==', 'production')
      .where('kind', '==', 'depix')
      .get();

    assert.ok(snap.size > 0);
    for (const doc of snap.docs) {
      assert.equal(doc.data()['enabled'], false, `${doc.id} não deveria vir habilitado`);
    }
  });

  it('taxas da plataforma começam em zero', async () => {
    const snap = await db.collection(COLLECTIONS.feeRules).get();
    assert.ok(snap.size >= 3);
    for (const doc of snap.docs) {
      assert.equal(doc.data()['percentPpm'], 0n);
      assert.equal(doc.data()['fixedAmount'], 0n);
    }
  });
});

describe('dinheiro é int64 exato, nunca float', () => {
  it('quantias fazem round-trip como bigint', async () => {
    const ref = db.doc('probe/money');
    await ref.set({
      money: 500_00000000n,
      big: 9_007_199_254_740_993n, // 2^53 + 1
      max: 9_223_372_036_854_775_807n,
    });

    const data = (await ref.get()).data()!;
    assert.equal(typeof data['money'], 'bigint');
    assert.equal(data['money'], 500_00000000n);
    assert.equal(data['big'], 9_007_199_254_740_993n, 'acima de 2^53 sem perder bit');
    assert.equal(data['max'], 9_223_372_036_854_775_807n);
  });

  it('a guarda recusa valor que não cabe em 64 bits', () => {
    assert.doesNotThrow(() => assertFitsInt64(9_223_372_036_854_775_807n, 'x'));
    assert.throws(() => assertFitsInt64(9_223_372_036_854_775_808n, 'x'), /não cabe em 64 bits/);
    assert.throws(() => assertFitsInt64(-9_223_372_036_854_775_809n, 'x'), /não cabe em 64 bits/);
  });

  it('saldos das contas de sistema nascem como bigint zero, não number', async () => {
    const snap = await db.collection(COLLECTIONS.ledgerAccounts).limit(1).get();
    const account = snap.docs[0]!.data() as LedgerAccountDoc;
    assert.equal(typeof account.balance, 'bigint');
    assert.equal(account.balance, 0n);
  });
});

describe('o ID do documento é a constraint UNIQUE', () => {
  it('create() no mesmo ID falha com ALREADY_EXISTS', async () => {
    // É o que substitui `UNIQUE` do PostgreSQL em todo o sistema:
    // idempotência de lançamento, EndToEndId, UTXO, evento de webhook.
    const ref = db.doc('probe/unique');
    await ref.create({ v: 1 });

    let captured: unknown;
    await ref.create({ v: 2 }).catch((e: unknown) => {
      captured = e;
    });

    assert.ok(captured, 'a segunda criação precisa falhar');
    assert.ok(isAlreadyExists(captured), 'e o código precisa ser reconhecível');
    assert.equal(asNumber((await ref.get()).data()!['v']), 1, 'o valor original permanece');
  });

  it('sanitiza componentes inseguros sem deixar chaves colidirem', () => {
    // `a/b` quebraria o caminho do documento. Trocar por `-` sem mais nada
    // faria `a/b` e `a-b` virarem o mesmo ID — e colisão em chave de
    // idempotência devolve a operação de outra pessoa.
    const comBarra = idComponent('a/b');
    const comTraco = idComponent('a-b');
    assert.notEqual(comBarra, comTraco);
    assert.doesNotMatch(comBarra, /\//);
  });

  it('IDs compostos são estáveis e distintos', () => {
    assert.equal(compositeId('a', 'b'), 'a__b');
    assert.notEqual(compositeId('a', 'b'), compositeId('a', 'c'));

    // O mesmo UTXO em direções diferentes são registros diferentes.
    const txid = 'a'.repeat(64);
    assert.notEqual(liquidTxId(txid, 0, 'in'), liquidTxId(txid, 0, 'out'));
    assert.notEqual(liquidTxId(txid, 0, 'in'), liquidTxId(txid, 1, 'in'));
  });

  it('o dedupe de webhook separa providers', () => {
    assert.notEqual(webhookEventId('depixapp', 'evt_1'), webhookEventId('eulen', 'evt_1'));
  });
});

describe('a arquitetura non-custodial está no modelo de dados', () => {
  it('nenhum documento gravado carrega seed, chave privada ou dado pessoal', async () => {
    // Enforcement do que antes era um teste sobre information_schema. O
    // Firestore não tem schema, então a varredura é sobre os documentos que o
    // bootstrap e o harness realmente escrevem.
    const proibidos =
      /^(seed|mnemonic|xprv|priv_?key|private_?key|secret_?key|blinding_?key|cpf|cnpj|tax_?number|full_?name|birth|selfie|document_?photo|income)$/i;

    const colecoes = [
      COLLECTIONS.assets,
      COLLECTIONS.ledgerAccounts,
      COLLECTIONS.providers,
      COLLECTIONS.feeRules,
      COLLECTIONS.users,
      COLLECTIONS.wallets,
      COLLECTIONS.limits,
    ];

    const encontrados: string[] = [];
    for (const colecao of colecoes) {
      const snap = await db.collection(colecao).limit(50).get();
      for (const doc of snap.docs) {
        for (const campo of Object.keys(doc.data())) {
          if (proibidos.test(campo)) encontrados.push(`${colecao}.${campo}`);
        }
      }
    }

    assert.deepEqual(encontrados, [], `Campos proibidos encontrados: ${encontrados.join(', ')}`);
  });

  it('a carteira guarda apenas descriptor watch-only, e ele nasce vazio', async () => {
    const { seedUser } = await import('../src/testing.ts');
    const { userId } = await seedUser(db);

    const snap = await db.collection(COLLECTIONS.wallets).where('userId', '==', userId).get();
    const wallet = snap.docs[0]!.data();

    assert.equal(wallet['custodyModel'], 'self');
    assert.equal(wallet['ctDescriptorEnc'], null);
    assert.ok(!('seed' in wallet) && !('xprv' in wallet));
  });
});

describe('regras de segurança', () => {
  it('o arquivo de regras nega todo acesso de cliente', async () => {
    // As regras não se aplicam ao Admin SDK — o papel delas é garantir que
    // nenhum cliente fale direto com o banco, contornando o ledger.
    const { readFile } = await import('node:fs/promises');
    const rules = await readFile(new URL('../../../firestore.rules', import.meta.url), 'utf8');

    assert.match(rules, /allow read, write: if false/);
    assert.doesNotMatch(
      rules.replace(/\/\/.*$/gm, ''),
      /allow (read|write|create|update|delete)[^:]*:\s*if\s+(true|request)/,
      'nenhuma regra pode liberar acesso direto de cliente',
    );
  });
});
