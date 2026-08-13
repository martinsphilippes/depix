# ARCHITECTURE.md — Discovery técnico e arquitetura

> **ETAPA 1 — Discovery.** Este documento é o diagnóstico técnico que precede qualquer código de integração.
> Data da pesquisa: **agosto de 2026**. Toda afirmação sobre APIs de terceiros tem fonte citada.
> Onde não há documentação pública, está escrito **INTEGRAÇÃO PENDENTE** — nada foi inventado.

---

## 0. Resumo executivo — o que dá para fazer hoje

| Fluxo | Viabilidade | Resumo |
|---|---|---|
| **1. Pix → DePix** | 🟡 **Possível mediante parceiro** | API real e documentada (DePix App / Eulen). Exige credencial aprovada. Sandbox disponível no DePix App. |
| **2. DePix → Pix** | 🟡 **Possível mediante parceiro** | API real, com fluxo **non-custodial**: o provider devolve endereço de depósito; o usuário assina no dispositivo. |
| **3. DePix → DePix (Liquid)** | 🟢 **Possível agora** | 100% nosso, sem parceiro. Rede Liquid pública, asset ID confirmado on-chain, bibliotecas maduras. |
| **4. DePix → DePix (Lightning/Taproot Assets)** | 🔴 **Não disponível** | DePix é ativo emitido na Liquid; Taproot Assets é protocolo do Bitcoin mainnet. Não existe ponte. Detalhes em §5. |

**A decisão arquitetural central:** o único fluxo que não depende de ninguém é o DePix↔DePix na Liquid. Os fluxos de fiat (1 e 2) **obrigatoriamente** passam por um operador autorizado — e isso é bom, porque é exatamente essa separação que nos mantém fora do perímetro regulatório de instituição de pagamento (ver REGULATORY_ARCHITECTURE.md).

---

## 1. Fatos verificados sobre o DePix

### 1.1 O ativo (confirmado on-chain, não em marketing)

Consulta direta ao Esplora da Blockstream em `blockstream.info/liquid/api/asset/<id>`:

```json
{
  "asset_id": "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
  "contract": {
    "entity":  { "domain": "depix.info" },
    "name":    "Decentralized Pix",
    "ticker":  "DePix",
    "precision": 8
  },
  "status": { "confirmed": true, "block_height": 2726480 },
  "chain_stats": { "issuance_count": 24, "issued_amount": 2300000100000002, "burned_amount": 0 }
}
```

| Propriedade | Valor confirmado |
|---|---|
| **Asset ID** | `02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189` |
| Rede | **Liquid Network mainnet** (sidechain do Bitcoin, federada) |
| Nome / ticker | Decentralized Pix / DePix |
| Precisão | **8 casas** — 1 DePix = 100.000.000 unidades mínimas |
| Domínio do emissor no contrato | `depix.info` |
| Emissor | **Eulen.app LLC** ([depix.info](https://depix.info/)) |
| Lastro | 1:1 em BRL, segundo o emissor |
| Reemissão | Token de reemissão existente — o emissor pode emitir mais |

> ⚠️ **Confirmação cruzada obrigatória.** O asset ID acima foi confirmado em três fontes independentes: o registro on-chain (Esplora), a [documentação da API do DePix App](https://depixapp.com/docs/en/) e o registro de ativos da Liquid. O sistema **deve** validar `asset_id` byte a byte em toda transação — ticker é texto livre na Liquid e qualquer pessoa pode emitir um ativo chamado "DePix".

### 1.2 Onde o DePix circula

Carteiras que já suportam o ativo, segundo [depix.info](https://depix.info/): SideSwap, Blockstream Green, Aqua (JAN3), e "qualquer carteira compatível com a Liquid". Isso é relevante para o fluxo 3: nosso usuário pode enviar DePix para qualquer uma dessas carteiras sem intermediário.

### 1.3 Confirmação importante sobre KYC

A própria documentação oficial diz: *"KYC requirements depend on the independent entity or platform you use to acquire or redeem DePix."* Ou seja — **o KYC é do operador, não do ativo e não de quem constrói software de carteira.** Isso valida diretamente a arquitetura de privacidade pedida na seção 18 dos requisitos.

---

## 2. Operadores de rampa fiat — o que existe de verdade

Foram encontrados **dois** operadores com API documentada publicamente. Comparação completa em PROVIDERS.md; o essencial para a arquitetura:

### 2.1 Eulen — "Pix2DePix API" (o emissor)

- Documentação: [docs.eulen.app](https://docs.eulen.app/)
- Base: `https://depix.eulen.app/api/`
- Auth: JWT RS256, `Authorization: Bearer <token>`; credenciais obtidas via **canal privado no Telegram** (comandos `/addclientcredentials`, `/apitoken`)
- Endpoints documentados: `/ping`, `/deposit`, `/deposit-status`, `/deposits`, `/withdraw`, `/withdraw-status`, `/registerwebhook`
- **Sem idempotência** — a doc afirma explicitamente que cada requisição é independente e recomenda consultar status antes de repetir
- Sandbox: **não documentado**

### 2.2 DePix App (gateway sobre o emissor)

- Documentação: [depixapp.com/docs/en](https://depixapp.com/docs/en/)
- Base: `https://api.depixapp.com`
- Auth: `Authorization: Bearer sk_live_<key>` ou `sk_test_<key>`
- **Sandbox real** (`sk_test_`), com respostas sintéticas marcadas `sandbox: true` e strings `SANDBOX-*-DO-NOT-PAY` impagáveis
- **Idempotency-Key** suportado em `/api/deposit`, `/api/withdraw`, `/api/checkouts` (TTL 24h, replay marcado com `Idempotency-Replayed: true`)
- Webhooks com **HMAC-SHA256 assinado** e ID de evento estável para dedupe
- Servidor MCP oficial open-source: [github.com/depixapp/depix-mcp](https://github.com/depixapp/depix-mcp)

O README do MCP oficial diz que o servidor não guarda "*no Eulen token*" — indicando que **o DePix App opera como camada de gateway sobre a API da Eulen**. Para nós isso significa: a Eulen é o emissor/operador de base, o DePix App é o parceiro de integração com melhor ergonomia técnica.

### 2.3 Recomendação

**Integrar primeiro com o DePix App**, pelos motivos técnicos que importam num sistema financeiro: sandbox (permite cumprir a seção 34 dos requisitos sem dinheiro real), idempotência nativa (seção 21), webhooks assinados (seção 22) e modelo declaradamente non-custodial no saque (seção 16/18).

Ambos ficam atrás da mesma interface `DepixProvider`. Trocar de operador é trocar uma implementação.

---

## 3. Fluxo 1 — Pix → DePix 🟡

**Classificação: possível mediante parceiro.** A API existe e está documentada; falta credencial aprovada (`sk_live_` exige aprovação manual após onboarding).

### Como funciona de verdade

```
Usuário pede "Receber R$ 500"
        │
        ▼
POST /api/deposit  { amountInCents: 50000, Idempotency-Key: <uuid> }
        │  → devolve QR Pix (copia-e-cola + imagem) e id da operação
        ▼
Usuário/pagador paga o Pix numa instituição bancária qualquer
        │
        ▼
Webhook deposit.*  →  validar HMAC  →  gravar bruto  →  responder 2xx  →  fila
        │
        ▼
Worker confirma status via GET /api/deposits/:id (não confia só no webhook)
        │
        ▼
Operador emite/transfere DePix para o endereço Liquid do usuário
        │
        ▼
Worker observa a transação na Liquid, valida asset_id, conta confirmações
        │
        ▼
Ledger: crédito em user_available  →  saldo atualizado
```

### Pontos críticos que a documentação nos obriga a respeitar

1. **O endereço de destino é nosso parâmetro.** O `POST /deposit` da Eulen aceita `depixAddress` opcional (`lq1…` / `ex1…`). Passando o endereço da carteira **do próprio usuário**, o DePix nunca passa pela nossa custódia. Esse é o ponto que torna o fluxo 1 non-custodial de ponta a ponta.
2. **Valores em centavos inteiros** — a API já trabalha assim (`amountInCents`), alinhado à regra de nunca usar float.
3. **`approved` é o sinal de confirmação** do lado fiat, mas isso ainda não é DePix na carteira. Só marcamos `COMPLETED` após ver a transação confirmada na Liquid. Um HTTP 200 nunca conclui transação (seção 12/43 dos requisitos).
4. **Limites reais existem.** No DePix App: máximo de 2 QRs por CPF/CNPJ a cada 30 minutos; limites por chave (padrão R$100/transação, R$500/dia); teto de 10.000.000 centavos por depósito na Eulen. Nosso motor de limites precisa refletir os limites do provider, não inventar os próprios.
5. **HTTP 422 = bloqueio por compliance screening** (Eulen). Precisa de tratamento explícito → estado `MANUAL_REVIEW`, nunca retry cego.

### O que é do provider, não nosso

Os campos `endUserFullName`, `endUserTaxNumber`, `euid` existem na API da Eulen. **Não vamos coletá-los nem armazená-los** enquanto o provider não os exigir para a operação. Se vierem a ser obrigatórios, a coleta deve ocorrer via onboarding hospedado do provider e guardamos apenas um token opaco (ver DATABASE.md, tabela `provider_authorizations`).

---

## 4. Fluxo 2 — DePix → Pix 🟡

**Classificação: possível mediante parceiro.** E — descoberta importante — **é genuinamente non-custodial.**

### O mecanismo real (documentado)

```
POST /api/withdraw  { pixKey, payoutAmountInCents, taxNumber, refundAddress }
        │
        ▼
Resposta:  depositAddress   → endereço Liquid do operador (saída confidencial)
           fee_address      → endereço de taxa (saída EXPLÍCITA/não-blindada)
           fee_cents, payoutAmountInCents, totalDepositAmountInCents
        │
        ▼
NOSSO CLIENTE monta a transação Liquid:
   • saída 1: DePix → depositAddress   (confidencial)
   • saída 2: DePix → fee_address      (NÃO-BLINDADA — obrigatório)
        │
        ▼
Usuário assina NO DISPOSITIVO e transmite (nosso servidor nunca vê a chave)
        │
        ▼
Operador detecta, converte e executa o Pix
        │
        ▼
Webhook withdraw.* + GET /api/withdrawals/:id → unsent | sending | sent
```

### Armadilha documentada que precisa virar teste automatizado

A documentação é explícita: a saída de taxa **precisa ser não-blindada e no asset DePix**; pagá-la blindada *"makes the withdrawal fail and can lose the funds"*. Isso não é detalhe de UX — é uma condição de perda de fundos. Consequência de projeto:

- O builder de transação de saque é código crítico, com testes de unidade que verificam explicitamente que a saída de taxa está desblindada e com o asset ID correto.
- Antes de transmitir, uma validação final inspeciona a transação montada. Se a saída de taxa estiver blindada ou com asset errado, **abortamos** — não transmitimos.

### 🔴 Lacuna importante: consulta de nome do recebedor (DICT)

A seção 8 dos requisitos pede que, ao digitar a chave Pix, o sistema mostre *"Nome: João da Silva / Instituição: Banco X"* antes de confirmar.

**Isso não é possível com a API atual do operador.** Não há endpoint documentado de validação de chave Pix nem de consulta DICT. A validação acontece na liquidação: chave errada resulta em `withdraw.error` com estorno para o `refundAddress`.

Três consequências honestas:

1. O `refundAddress` **não é opcional na prática** — nossa implementação sempre o preenche com um endereço da carteira do próprio usuário. É a rede de segurança para chave inválida.
2. A UI **não pode mentir**. Em vez de exibir um nome que não temos, a tela de revisão mostra a chave digitada em destaque, pede confirmação explícita e avisa que a validação ocorre na liquidação. Interface honesta > interface bonita.
3. A interface `PixProvider.getRecipient()` fica **definida e implementada como INTEGRAÇÃO PENDENTE**. Se contratarmos um provider Pix com acesso ao DICT (ver PROVIDERS.md), a funcionalidade liga sem reescrever o fluxo.

### Custos reais (DePix App, documentados)

| Operação | Taxa do provider |
|---|---|
| Depósito (Pix→DePix) | 2% + R$ 0,99 |
| Saque ≤ R$ 100 | 1% + R$ 1,00 |
| Saque > R$ 100 | 2% |

Nosso motor de taxas (seção 26) soma a taxa do provider + a nossa e **sempre exibe o total antes da confirmação**. A taxa do provider é buscada da cotação real, nunca estimada.

### Restrição de compliance do provider

*"First withdrawal must match the CPF/CNPJ of the first completed deposit"* — o operador amarra o primeiro saque ao CPF do primeiro depósito. Isso é regra **dele**, e a arquitetura a respeita sem contorná-la (seção 43 dos requisitos). Nós apenas propagamos o erro de forma compreensível ao usuário.

---

## 5. Fluxo 4 — Lightning / Taproot Assets 🔴

**Classificação: não disponível atualmente.** Esta é a conclusão mais importante do discovery, e ela contraria material de marketing que circula na web.

### Por que não funciona

DePix é um **ativo emitido na Liquid Network**. Taproot Assets é um **protocolo distinto, que emite ativos no Bitcoin mainnet** e os roteia por canais Lightning ([Lightning Labs](https://docs.lightning.engineering/the-lightning-network/taproot-assets)). São dois esquemas de emissão em duas cadeias diferentes. Um ativo emitido em um **não é transferível** pelo outro — não existe "mesmo token nas duas redes" sem uma ponte, e nenhuma ponte DePix Liquid ↔ Taproot Assets foi encontrada.

### Sobre a alegação de que "DePix está disponível via Taproot Assets"

Uma página de glossário de terceiros afirma que *"regional stablecoins like DePix (a Brazilian real stablecoin) are also available through the ecosystem"*. **Tratamos essa afirmação como não confirmada e não vamos construir sobre ela**, porque:

- A documentação oficial ([depix.info](https://depix.info/)) **não menciona** Lightning nem Taproot Assets em lugar nenhum.
- O registro on-chain mostra o ativo emitido na Liquid, não no Bitcoin.
- A mesma página confirma que Taproot Assets é Bitcoin mainnet.

Se algum dia a Eulen emitir um DePix espelhado em Taproot Assets, isso será um **ativo diferente, com identificador diferente**, e exigirá integração própria. A regra 43 ("nunca invente uma API") se aplica aqui de forma literal.

### O que Boltz realmente suporta (consulta ao vivo na API)

`GET https://api.boltz.exchange/v2/swap/submarine` retornou, no momento da pesquisa:

```
BTC → BTC     (Lightning ↔ Bitcoin on-chain)
L-BTC → BTC   (Lightning ↔ Liquid Bitcoin)
ARK → BTC
```

Somente ativos **denominados em bitcoin**. Nenhum ativo Liquid além do L-BTC. Boltz não resolve DePix↔Lightning.

*(Nota: uma busca sugeriu que o Boltz estaria suspenso desde 03/08/2026. A consulta direta à API respondeu normalmente (HTTP 200) com pares ativos, então essa informação não se confirmou. Serve de lembrete: verificar o serviço, não o resumo sobre o serviço.)*

### O que o Breez SDK Nodeless realmente faz

O [Breez SDK Nodeless](https://sdk-doc-liquid.breez.technology/guide/assets.html) roda sobre a Liquid e suporta **ativos Liquid arbitrários** via `asset_metadata` (asset ID + nome + ticker + precisão) — o DePix caberia aqui. Mas a documentação é clara: pagar uma invoice Lightning em BTC a partir de saldo de um ativo não-BTC **não é suportado**. O SDK faz troca entre ativos Liquid, não roteamento cross-asset por Lightning.

### Único caminho que existiria hoje — e por que não vamos vendê-lo como "Lightning"

É tecnicamente possível **compor** serviços:

```
Invoice Lightning (BTC)
   → Boltz submarine swap → L-BTC na Liquid      [real, documentado]
   → SideSwap atomic swap L-BTC → DePix          [real, DePix/L-BTC documentado]
   → DePix na carteira do usuário
```

Cada perna é real. Mas o conjunto tem características que o desqualificam como funcionalidade de carteira em reais para usuário comum:

- **Exposição ao preço do BTC** entre as pernas. O usuário quer R$ 100 e fica exposto à volatilidade do bitcoin durante o swap.
- **Duas contrapartes**, dois pontos de falha, e uma falha no meio deixa o usuário com L-BTC — um ativo que ele não pediu.
- Taxas somadas de três serviços.

**Decisão:** o botão "Lightning" da carteira (seção 6 dos requisitos) existe na UI como **estado explícito de indisponibilidade**, não como funcionalidade quebrada. A interface `LightningProvider` fica definida, com a implementação composta acima documentada como caminho futuro atrás de feature flag desligada. Ligar isso é decisão de produto sobre exposição cambial, não de engenharia.

---

## 6. Fluxo 3 — DePix → DePix na Liquid 🟢

**Classificação: possível agora, sem nenhum parceiro.** É a base do sistema e a primeira coisa a implementar.

### Stack escolhida

| Componente | Escolha | Versão verificada (npm, ago/2026) | Papel |
|---|---|---|---|
| **Carteira/assinatura (cliente)** | **LWK** (Liquid Wallet Kit, Blockstream) via `lwk_wasm` | `0.18.0` | Descriptors CT, blinding, seleção de UTXO por asset, assinatura |
| Manipulação de transação (baixo nível) | `liquidjs-lib` | `6.0.2-liquid.38` | Fallback e construção fina — necessário para a saída de taxa não-blindada do saque |
| Indexação/monitoramento (servidor) | Blockstream **Esplora** (`blockstream.info/liquid/api`) | — | Detecção de depósito, confirmações, reconciliação |
| Alternativa futura | Breez SDK Nodeless | `@breeztech/breez-sdk-liquid 0.12.4` | Se quisermos L-BTC/Lightning nativo depois |

**Por que LWK e não liquidjs-lib puro:** o LWK é da própria Blockstream (mantenedora da Liquid), licença MIT, com bindings para WASM, Python, Kotlin e Swift — o mesmo núcleo serve web hoje e mobile depois. Ele já resolve o que é chato e perigoso de fazer à mão: descriptors confidenciais, blinding keys, seleção de UTXO respeitando asset, e integração com hardware wallet (Jade, Ledger). Escrever isso do zero em `liquidjs-lib` seria reimplementar código de custódia — exatamente onde bugs custam dinheiro.

**Onde `liquidjs-lib` ainda entra:** a saída explícita não-blindada exigida pelo fluxo de saque (§4) é um requisito incomum. Se a API de alto nível do LWK não expuser esse controle, a montagem dessa transação específica desce para `liquidjs-lib`. Isso está sinalizado como risco técnico a validar em spike antes da ETAPA 3.

### Características da rede que a UI precisa respeitar

- Bloco de ~1 minuto; o DePix App trata 1ª confirmação como `approved` e 2ª como `completed`. Adotamos o mesmo critério.
- Taxas pagas em **L-BTC**, não em DePix. **Consequência de produto séria:** um usuário com R$ 500 em DePix e zero L-BTC **não consegue transmitir uma transação**. A carteira precisa manter uma reserva mínima de L-BTC e a UI precisa tratar isso sem expor o conceito ao usuário comum (seção 32). Isso é um problema de onboarding real, não um detalhe.
- **Confidential Transactions**: valores e assets são blindados por padrão. Para o servidor detectar depósitos ele precisa da *master blinding key* em modo watch-only — daí o `ct_descriptor` no schema (DATABASE.md). Ele permite **ver**, nunca **gastar**.

### Proteção contra envio do asset errado

Obrigatório em três camadas: (1) validar o asset ID contra a tabela `assets` na seleção de UTXO; (2) validar a transação montada antes de assinar; (3) validar o endereço de destino — impedir envio a endereço de rede incompatível (ex.: endereço Bitcoin colado no campo Liquid).

---

## 7. Custódia — a decisão

Comparação pedida na seção 16 dos requisitos:

| Modelo | Risco de custódia | Complexidade | Recovery | Viabiliza os 4 fluxos? |
|---|---|---|---|---|
| **A. Non-custodial** | **Nenhum para o operador** — não podemos ser roubados nem obrigados a mover fundos alheios | Média-alta (recovery é o problema difícil) | Responsabilidade do usuário; mitigável | **Sim** — confirmado: o saque do DePix App já é desenhado para assinatura no cliente |
| **B. Custodial** | Alto. Guardar fundos de terceiros é a atividade que atrai o perímetro regulatório mais pesado | Baixa para programar, altíssima para operar com segurança | Trivial (reset de senha) | Sim |
| **C. MPC / híbrido** | Médio — reduz ponto único de falha, mas o servidor participa da assinatura | Alta (threshold signing, ceremony, rotação) | Boa (recuperação por shares) | Sim |

### Decisão: **A — non-custodial**, com MPC como evolução opcional

Não por facilidade — pelo contrário, é o caminho mais trabalhoso. É a escolha certa por três razões que se reforçam:

1. **O provider já foi desenhado assim.** O saque devolve endereço de depósito e espera transação assinada pelo cliente. Custodiar seria adicionar risco que a API nem exige.
2. **Reduz o perímetro regulatório.** Não custodiar ativos de terceiros muda materialmente a natureza da atividade (ver REGULATORY_ARCHITECTURE.md).
3. **É coerente com a seção 18.** Sem custódia, o servidor não precisa saber quem é o usuário — ele não move nada sozinho.

**O que isso significa concretamente:** o servidor armazena o `ct_descriptor` watch-only (xpub + master blinding key). Isso permite mostrar saldo, detectar depósitos e conciliar. **Não permite gastar.** Não existe, e não existirá, coluna de seed ou xprv no banco, nem caminho de assinatura remota.

### O ponto honesto sobre o modo sandbox

Durante a ETAPA 2, para desenvolver ledger, conciliação e admin sem depender da carteira do cliente, existirá um modo `custody_model = 'server'` **restrito a ambiente de desenvolvimento/testnet**. Ele é bloqueado por configuração em produção. Isso é andaime de desenvolvimento e está marcado como tal no schema — não é o produto.

---

## 8. Arquitetura em quatro camadas

Conforme a seção 18.12 dos requisitos:

```
┌─────────────────────────────────────────────────────────────┐
│  WALLET LAYER            (roda no dispositivo do usuário)   │
│  chaves · assinatura · descriptors · saldo local · LWK      │
│  ▸ nunca envia seed/chave privada para o servidor           │
└─────────────────────────────────────────────────────────────┘
              │ transações assinadas · endereços públicos
              ▼
┌─────────────────────────────────────────────────────────────┐
│  BLOCKCHAIN LAYER                              (servidor)   │
│  Esplora · confirmações · asset ID · reorg · broadcast      │
│  ▸ watch-only: observa, nunca gasta                         │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  FIAT GATEWAY LAYER                            (servidor)   │
│  DepixProvider · PixProvider · cotação · taxas · webhooks   │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  PROVIDER COMPLIANCE LAYER                     (no provider)│
│  onboarding hospedado · limites · autorizações              │
│  ▸ guardamos apenas status + token opaco                    │
└─────────────────────────────────────────────────────────────┘
```

A Wallet Layer **não importa nada** da Provider Compliance Layer. Um usuário que só usa DePix↔DePix nunca toca nas camadas 3 e 4 — e portanto nunca precisa se identificar para ninguém.

---

## 9. Interfaces de adapter

Definidas na ETAPA 1, implementadas na ETAPA 2. Assinaturas conceituais:

```ts
interface DepixProvider {
  createDeposit(p: { amountCents: bigint; destinationAddress: string;
                     idempotencyKey: string }): Promise<DepositQuote>;
  getDeposit(id: string): Promise<DepositStatus>;
  quoteWithdrawal(p: { pixKey: string; payoutCents?: bigint;
                       depositCents?: bigint; taxNumber: string;
                       refundAddress: string;
                       idempotencyKey: string }): Promise<WithdrawalQuote>;
  getWithdrawal(id: string): Promise<WithdrawalStatus>;
  verifyWebhook(raw: Buffer, headers: Headers): WebhookVerification;
}

interface PixProvider {          // parcialmente INTEGRAÇÃO PENDENTE
  createDeposit(...): Promise<PixCharge>;
  createQrCode(...): Promise<PixQr>;
  getPayment(...): Promise<PixPayment>;
  sendPix(...): Promise<PixPayout>;
  validatePixKey(...): Promise<KeyValidation>;   // ⛔ PENDENTE — sem DICT hoje
  getRecipient(...): Promise<RecipientInfo>;     // ⛔ PENDENTE — sem DICT hoje
  handleWebhook(...): Promise<WebhookResult>;
}

interface LiquidProvider {       // 🟢 implementável agora
  deriveAddress(...): Promise<LiquidAddress>;
  getBalance(walletId, assetId): Promise<bigint>;
  buildTransfer(...): Promise<UnsignedTx>;   // assinatura acontece no cliente
  broadcast(signedTx): Promise<Txid>;
  getTransaction(txid): Promise<LiquidTxStatus>;
  estimateFee(...): Promise<bigint>;         // em L-BTC
}

interface LightningProvider { /* ⛔ INTEGRAÇÃO PENDENTE — ver §5 */ }
interface SwapProvider     { /* SideSwap DePix↔L-BTC — documentado, não priorizado */ }
```

---

## 10. Stack e infraestrutura

| Camada | Escolha | Justificativa |
|---|---|---|
| Frontend | Next.js + TypeScript | Conforme preferência; a Wallet Layer roda no browser via `lwk_wasm` |
| Backend financeiro | Node.js + TypeScript, **processo persistente** (container dedicado) | **Não serverless.** Workers de confirmação on-chain e conciliação são processos longos. Vercel para o frontend, backend em infra dedicada (seção 36) |
| Banco | PostgreSQL / Supabase | Ledger com locks e constraints — ver DATABASE.md |
| Filas | Fila persistente com Redis (BullMQ) ou fila no próprio Postgres | Webhooks e confirmações não podem depender do request HTTP |
| Observabilidade | Logging estruturado com redaction obrigatória | Ver SECURITY.md |

**Workers necessários:** confirmação de depósito Pix; observação de confirmações na Liquid; entrega/reprocessamento de webhooks; conciliação (4 fontes); notificações; expiração de cobranças.

---

## 11. Riscos técnicos identificados

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| 1 | Saída de taxa blindada no saque → **perda de fundos** (risco documentado pelo provider) | 🔴 Crítica | Validação pré-broadcast + testes obrigatórios; abortar em vez de transmitir |
| 2 | Usuário sem L-BTC não consegue transacionar | 🟠 Alta | Reserva mínima de L-BTC; UX que resolve sem expor o conceito |
| 3 | Sem DICT: usuário digita chave Pix errada | 🟠 Alta | `refundAddress` sempre preenchido; confirmação explícita; UI honesta |
| 4 | Perda de seed = perda de fundos (non-custodial) | 🟠 Alta | Fluxo de backup obrigatório antes do primeiro depósito |
| 5 | Credencial `sk_live_` depende de aprovação manual | 🟡 Média | Desenvolver 100% em sandbox; adapter permite trocar de operador |
| 6 | Asset falso com ticker "DePix" | 🟡 Média | Validação de asset ID byte a byte em três camadas |
| 7 | Eulen sem idempotência nativa | 🟡 Média | Idempotência do nosso lado + consulta de status antes de retry |

---

## 12. O que fica claro sobre o escopo

**Somos software de carteira**, não instituição financeira. As duas operações que tocam dinheiro de verdade (fluxos 1 e 2) são executadas por um operador autorizado; nós orquestramos, exibimos e conciliamos. As operações que são só criptografia e rede (fluxo 3) são inteiramente nossas.

Essa fronteira não é acidental — ela é o que permite cumprir simultaneamente a seção 18 (privacidade) e a seção 19 (regulação). Detalhamento em REGULATORY_ARCHITECTURE.md.

---

## Fontes

- [DePix — site oficial](https://depix.info/)
- [Registro on-chain do ativo — Blockstream Esplora (Liquid)](https://blockstream.info/liquid/api/asset/02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189)
- [Eulen — Pix2DePix API](https://docs.eulen.app/)
- [Eulen — endpoint de depósito](https://docs.eulen.app/deposit-pix-depix-12532107e0)
- [DePix App — documentação da API](https://depixapp.com/docs/en/)
- [DePix App — servidor MCP oficial](https://github.com/depixapp/depix-mcp)
- [SideSwap — parceria DePix](https://sideswap.io/news/depix-partnership/)
- [Blockstream LWK (Liquid Wallet Kit)](https://github.com/Blockstream/lwk)
- [liquidjs-lib](https://github.com/vulpemventures/liquidjs-lib)
- [Breez SDK Nodeless — múltiplos ativos](https://sdk-doc-liquid.breez.technology/guide/assets.html)
- [Lightning Labs — Taproot Assets](https://docs.lightning.engineering/the-lightning-network/taproot-assets)
- [Boltz — API de swaps](https://api.boltz.exchange/v2/swap/submarine)
- [BTCPay Server — plugin DePix](https://github.com/thgO-O/btcpayserver-plugin-depix)
