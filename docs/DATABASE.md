# DATABASE.md — Modelo de dados (Firestore)

> **Banco:** Cloud Firestore (Firebase), modo nativo.
> **Status:** implementado e testado contra o emulador — 184 testes.
>
> Este documento substitui a versão PostgreSQL. A seção 2 é a mais importante:
> ela descreve o que mudou nas **garantias**, não só na sintaxe.

---

## 1. Convenções

| Convenção | Regra |
|---|---|
| Identificadores | ID de documento gerado pelo Firestore, ou chave determinística quando o ID **é** a constraint (§3) |
| Dinheiro | `bigint` gravado como inteiro de 64 bits nativo. **Nunca** `number` |
| Contadores | inteiros também, mas normalizados com `asNumber()` na leitura (§4) |
| Datas | `Date` (Timestamp do Firestore), sempre UTC |
| Campo ausente | `null` explícito. O SDK está configurado para **lançar** em `undefined` |
| Schema | não existe no banco. O schema é `packages/firestore/src/types.ts` + as invariantes de `packages/ledger` |

**Proibições absolutas**

- Escrever quantia como `number` (double perde precisão acima de 2^53).
- Escrever em `ledgerEntries` ou no campo `balance` de `ledgerAccounts` fora de `packages/ledger/src/posting.ts`.
- Criar campo para seed, mnemônico, xprv, chave privada, CPF, nome completo ou documento.
- Calcular saldo somando o histórico de transações — saldo vem do ledger.

---

## 2. ⚠️ O que mudou nas garantias ao sair do PostgreSQL

Esta é a seção que precisa ser lida antes de mexer no ledger.

### 2.1 O que se perdeu

No PostgreSQL, três invariantes eram impostas **pelo banco**, por trigger, e valiam mesmo contra a própria aplicação:

1. lançamentos imutáveis — `UPDATE`/`DELETE` levantavam exceção;
2. partidas dobradas fechando em zero por ativo;
3. saldo de usuário nunca negativo.

O Firestore não tem triggers. E suas regras de segurança **não se aplicam ao Admin SDK** — credenciais de service account contornam as regras por completo. Isso foi **verificado empiricamente** contra o emulador (regras `deny-all` + escrita do Admin SDK bem-sucedida), não presumido.

**Consequência:** as três invariantes passaram a ser de aplicação. Elas vivem em `packages/ledger/src/posting.ts` e em nenhum outro lugar.

### 2.2 O que isso exige na prática

| Antes (PostgreSQL) | Agora (Firestore) |
|---|---|
| Trigger recusa `UPDATE` em lançamento | Nenhuma função de update/delete existe no módulo, e não deve passar a existir |
| Constraint trigger verifica soma zero | Validação em memória antes da fase de escrita |
| Trigger bloqueia saldo negativo | Checagem em memória, dentro da transação |
| Conciliação era conferência de rotina | **A conciliação virou parte do mecanismo de garantia** |

O último ponto é o mais importante. `reconcileAccount()` recomputa o saldo somando os lançamentos e compara com a projeção. No PostgreSQL isso era uma segunda linha de defesa; aqui é a **única** forma de detectar que algo escreveu no banco por fora do ledger. Ela precisa rodar com frequência e ter alarme.

Há teste específico para isso: `packages/ledger/test/ledger.test.ts` adultera o saldo por fora do ledger e verifica que a conciliação detecta.

### 2.3 O que **não** se perdeu

| Garantia | Como é mantida |
|---|---|
| **Idempotência** | O ID do documento **é** a chave, e `create()` falha com `ALREADY_EXISTS`. Mesma força de um `UNIQUE` |
| **Sem gasto duplo** | Concorrência otimista: o Firestore reexecuta a transação quando um documento lido mudou, então a segunda tentativa relê o saldo já debitado |
| **Precisão do dinheiro** | `useBigInt: true` + inteiro de 64 bits nativo. Round-trip exato verificado até `9223372036854775807n` |
| **Cliente não fala com o banco** | `firestore.rules` nega tudo. É o papel real das regras aqui |

### 2.4 O que melhorou

O teste de gasto duplo concorrente **agora roda na suíte padrão**. Na versão PostgreSQL ele era pulado: os testes usavam PGlite, que tem sessão única, e contenção de lock não acontecia. O emulador do Firestore suporta transações concorrentes, então a propriedade é verificada de fato — em qualquer máquina, sem infraestrutura extra.

São quatro testes: dois envios simultâneos do saldo inteiro, dez tentativas simultâneas, vinte créditos concorrentes (nenhum pode se perder na reexecução) e oito retries da mesma chave de idempotência em paralelo.

---

## 3. O ID do documento como constraint UNIQUE

O Firestore não tem `UNIQUE (a, b)`. Mas `create()` falha se o documento existe — então toda chave que precisa ser única vira o próprio ID.

| Constraint do PostgreSQL | Documento no Firestore |
|---|---|
| `ledger_transactions.idempotency_key UNIQUE` | ID de `ledgerTransactions` |
| `sessions.token_hash UNIQUE` | ID de `sessions` (é o SHA-256 do token) |
| `transactions (user_id, idempotency_key)` | ID em `txIdempotencyIndex` |
| `pix_transactions.e2e_id UNIQUE` | ID em `e2eIndex` |
| `liquid_transactions (txid, vout, direction)` | ID composto em `liquidTransactions` |
| `webhook_events (provider_id, external_id)` | ID composto em `webhookEvents` |
| `providers (code, environment)` | ID composto em `providers` |

**Sanitização de ID.** `/` quebraria o caminho do documento. Trocar por `-` sem mais nada faria `a/b` e `a-b` colidirem — e colisão em chave de idempotência devolve a operação de outra pessoa. Por isso `idComponent()` acrescenta um sufixo derivado do original quando houve substituição. Há teste.

---

## 4. A armadilha do `useBigInt`

`useBigInt: true` é obrigatório: sem ele, o SDK devolve inteiros como `number` (double) e quantias acima de 2^53 perdem precisão silenciosamente.

Mas a flag é **global**. Todo inteiro volta como `bigint`, inclusive os que não são dinheiro — `decimals`, `vout`, `confirmations`, `seq`. Isso quebra duas coisas de forma silenciosa:

- aritmética misturada: `seq + 1` com `seq` bigint lança `TypeError`;
- `JSON.stringify` **lança** em bigint — um contador lido do banco e devolvido numa resposta HTTP derruba a requisição.

**Regra:** todo contador lido do Firestore passa por `asNumber()`. Dinheiro nunca passa — quantia é `bigint` do começo ao fim. E nenhuma quantia atravessa a fronteira HTTP crua: sai como string.

Há teste de API que varre a resposta JSON inteira procurando bigint.

---

## 5. Coleções

### Identidade (mínima)

```
users/{userId}
  handle, email?, emailVerified, status, advancedMode, createdAt, updatedAt
  ▸ sem nome, CPF, RG, endereço, renda, documentos ou finalidade de transação

users/{userId}/devices/{deviceId}
users/{userId}/credentials/{credentialId}     ← passkey | password | totp
sessions/{sha256(token)}                       ← o ID é o hash; o token nunca é gravado
authAttempts/{autoId}                          ← rate limiting por conta E por IP (hash)
adminUsers/{adminId}
```

O CPF exigido pelo operador no saque (`taxNumber`) é transmitido e **descartado**: não há campo para ele em lugar nenhum.

### Carteira

```
assets/{BRL|DEPIX|LBTC}
  code, network, liquidAssetId, decimals, displayName, enabled

wallets/{walletId}
  userId, custodyModel, ctDescriptorEnc, backupStatus
  ▸ descriptor CT watch-only, cifrado. Permite VER, nunca gastar.

wallets/{walletId}/addresses/{addressId}
```

### Ledger (fonte de verdade)

```
ledgerAccounts/{accountCode}
  code, ownerUserId, assetCode, kind, balance, entryCount
  ▸ `balance` é projeção mantida NA MESMA transação que grava os lançamentos

ledgerTransactions/{idempotencyKey}            ← o ID é a constraint
  idempotencyKey, transactionId, description, actor, createdAt

ledgerEntries/{idempotencyKey}__{índice}
  ledgerTxId, accountCode, assetCode, side, amount, balanceAfter
  ▸ `balanceAfter` é a trilha que permite à conciliação apontar onde divergiu
```

Plano de contas: `user_available`, `user_pending_in`, `user_pending_out`, `system_fees`, `system_settlement`, `system_reserve`, `system_adjustment`, `system_refunds`, `external_world`.

`external_world` é a contrapartida do que entra e sai do perímetro do sistema. Fica negativa por construção — mede quanto o mundo externo "deve" ao conjunto das carteiras.

### Transações e trilhos

```
transactions/{transactionId}
transactions/{transactionId}/events/{seq}      ← trilha de transição de estado
txIdempotencyIndex/{userId}__{key}             ← constraint de idempotência
pixTransactions/{transactionId}
depixTransactions/{transactionId}
liquidTransactions/{txid}__{vout}__{direction} ← o mesmo UTXO nunca credita 2x
lightningTransactions/{transactionId}          ← estrutura pronta, integração pendente
swaps/{transactionId}
e2eIndex/{e2eId}                               ← o mesmo Pix nunca credita 2x
```

`pixTransactions` **não** tem campos de nome/instituição do recebedor: nenhum operador DePix expõe consulta DICT hoje. Serão adicionados se e quando contratarmos um provider com acesso ao diretório.

### Providers, webhooks, fila

```
providers/{code}__{environment}
providerAuthorizations/{userId}__{providerCode}   ← substitui "kyc_profiles"
providerTransactions/{autoId}
webhookEvents/{providerCode}__{externalId}        ← o ID é o dedupe
jobQueue/{dedupeKey}                              ← o ID é o dedupe da fila
```

`providerAuthorizations` guarda apenas **status opaco** e token do provider. Documentos, selfies e dados pessoais ficam no provider (onboarding hospedado).

### Configuração e operação

```
feeRules/{autoId}          ← versionadas por vigência; regra em uso nunca é editada
limits/{userId}
contacts/{userId}/items/{contactId}
notifications/{userId}/items/{id}
auditLogs/{autoId}
reconciliationRuns/{runId}
reconciliationEntries/{autoId}
```

---

## 6. Protocolo de escrita no ledger

O Firestore exige **todas as leituras antes de todas as escritas** numa transação. Isso muda a forma de escrever código financeiro: onde no SQL bastava intercalar, aqui é preciso ler tudo, decidir, e só então escrever.

```
runTransaction:

  ── LEITURA ────────────────────────────────────────────
  ler ledgerTransactions/{chave}
      └─ existe? → devolve { deduplicated: true }, fim
  ler todas as ledgerAccounts envolvidas (getAll, uma ida à rede)

  ── VALIDAÇÃO (em memória) ─────────────────────────────
  ativo da perna bate com o da conta?
  soma zero por ativo?
  algum saldo de usuário ficaria negativo?
  algum valor estoura int64?

  ── ESCRITA ────────────────────────────────────────────
  create ledgerTransactions/{chave}      ← constraint de idempotência
  create ledgerEntries/{chave}__{i}      ← com balanceAfter
  update balance de cada conta
```

Se outra transação criar o documento de idempotência no meio do caminho, o Firestore aborta e reexecuta — e a releitura devolve `deduplicated: true`. Se um saldo lido mudar, idem: a validação roda de novo sobre o estado novo.

**Ordem obrigatória em toda saída de valor:** reservar no ledger **antes** de qualquer chamada de rede. Inverter abriria a janela em que dois envios simultâneos leem o mesmo saldo.

---

## 7. Índices

`firestore.indexes.json` define os índices compostos. Os dois primeiros são os que sustentam a conciliação:

| Coleção | Campos | Para quê |
|---|---|---|
| `ledgerEntries` | `accountCode`, `side` | recomputar saldo de uma conta |
| `ledgerEntries` | `assetCode`, `side` | verificar que a soma global é zero |
| `transactions` | `userId`, `createdAt desc` | extrato |
| `authAttempts` | `subject`, `kind`, `succeeded`, `createdAt desc` | rate limiting |
| `feeRules` | `operation`, `activeFrom desc` | regra vigente |
| `jobQueue` | `queue`, `completedAt`, `runAfter` | fila |

A soma usa `AggregateField.sum` — agregação do lado do servidor, então o custo não cresce com o histórico da conta.

---

## 8. Limites do Firestore que afetam o desenho

| Limite | Efeito no sistema |
|---|---|
| Leituras antes de escritas na transação | Validação inteira em memória, entre as duas fases |
| 500 escritas por transação/lote | Lançamentos têm poucas pernas; nunca chegamos perto |
| `in` aceita até 30 valores | O extrato fatia a busca de detalhes em blocos de 30 |
| Sem `JOIN` | Detalhes por trilho vêm em consultas em lote, uma por trilho para a página inteira — nunca N+1 |
| Sem desigualdade em dois campos diferentes | A vigência de taxa é filtrada em memória sobre um conjunto pequeno |
| Sem `GROUP BY` | A verificação global roda uma agregação por ativo |

---

## 9. Minimização de dados — checklist por campo

| Dado | Armazenamos? | Justificativa |
|---|---|---|
| Nome / CPF / documentos do usuário | ❌ | Nenhuma funcionalidade técnica nossa exige; compliance é do provider |
| E-mail | ⚠️ opcional | Somente recovery/alertas; pode ser `null` |
| Chave Pix de terceiros (contatos) | ⚠️ cifrada | Funcionalidade do usuário; cifrada, exportável, apagável |
| Nome do recebedor Pix | ❌ | Não temos (sem DICT) e não inventamos |
| EndToEndId | ✅ | Necessário para conciliação e idempotência |
| IP puro | ❌ (hash com salt) | Detecção de anomalia funciona com hash |
| Saldo → analytics | ❌ | Proibido enviar a telemetria |
| **CPF/CNPJ do saque** | ❌ **não persistido** | Exigido pela API do operador, transmitido e descartado. Usuário redigita a cada saque |
| Seed / chave privada | ❌ NUNCA | Non-custodial; assinatura no dispositivo |

Há teste que varre os documentos gravados e falha se qualquer campo proibido aparecer.

---

## 10. Ambientes

| Ambiente | Firestore | Gate |
|---|---|---|
| Desenvolvimento / teste | Emulador (`FIRESTORE_EMULATOR_HOST`) | A aplicação **recusa** subir apontada para projeto real sem `ALLOW_REAL_FIRESTORE=yes` |
| Produção | Projeto real | Recusa emulador; recusa projeto `demo-*`; exige `ENABLE_REAL_FUNDS=yes` |

Risco que não existia com PostgreSQL: a diferença entre banco de brincadeira e banco de produção é uma variável de ambiente. E a suíte de testes **apaga todos os documentos** antes de cada arquivo — por isso o harness recusa rodar sem emulador, e a configuração da API recusa desenvolvimento apontado para o projeto real.
