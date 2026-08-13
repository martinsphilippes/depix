# PROVIDERS.md — Pesquisa de fornecedores

> Pesquisa realizada em **agosto de 2026**. Cada afirmação tem fonte.
> Onde não há documentação pública, está escrito **não documentado** — nada foi inferido ou inventado.
> Custos e limites mudam; reconferir antes de contratar.

---

## 1. Rampa fiat DePix (Pix ↔ DePix)

Foram encontrados **dois** operadores com API pública documentada.

### 1.1 Eulen — Pix2DePix API

| Item | Informação |
|---|---|
| Papel | **Emissor do DePix** (Eulen.app LLC, conforme [depix.info](https://depix.info/)) e operador de rampa |
| Documentação | [docs.eulen.app](https://docs.eulen.app/) |
| Base URL | `https://depix.eulen.app/api/` |
| Autenticação | JWT RS256 — `Authorization: Bearer <token>` |
| Obtenção de credenciais | **Canal privado no Telegram** com a Eulen: `/addclientcredentials <label>` (client_id/secret, recomendado) ou `/apitoken <label> <days> [all\|deposit\|withdraw\|user]` (token longo, até 365 dias) |
| Troca de credenciais por token | `POST /api/v2/auth/login` |
| Escopos | `deposit`, `withdraw`/`withdrawal`, `user` |
| Sandbox | **Não documentado** |
| Idempotência | **Não suportada.** A doc afirma que cada requisição é independente e recomenda consultar status antes de repetir |
| Webhooks | `/registerwebhook` — eventos `deposit`, `withdraw`, `med` |
| SDK oficial | Não encontrado |
| Repositório | [github.com/eulen-repo/DePix](https://github.com/eulen-repo/DePix) (documentação/whitepaper do token, não SDK) |

**Endpoints documentados**

| Endpoint | Método | Função |
|---|---|---|
| `/ping` | GET | Valida o token e devolve as claims decodificadas |
| `/deposit` | POST | Cria conversão BRL→DePix com QR Pix dinâmico |
| `/deposit-status` | GET | Status de um depósito |
| `/deposits` | GET | Consulta em lote por período e status |
| `/withdraw` | POST | Inicia payout DePix→BRL para uma chave Pix |
| `/withdraw-status` | GET | Status de um saque |
| `/registerwebhook` | POST | Registra endpoints de webhook |

**`POST /deposit` — campos documentados**

Obrigatório: `amountInCents` (inteiro, 1 a 10.000.000).
Opcionais: `depixAddress` (endereço Liquid de destino, `lq1…`/`ex1…`), `depixSplitAddress`, `splitFee`, `euid`, `endUserFullName`, `endUserTaxNumber`, `whitelist`, `delayDepixInHours` (1–720), `merchantId`, `timeout` (1200–86400 s).

Resposta: `qrCopyPaste`, `qrImageUrl`, `id`, `delayInHours`; header `X-Nonce` como id de correlação.

Erros relevantes: `422` bloqueio por compliance screening; `503` operação congelada / broker indisponível; `520` requisição rejeitada com `errorMessage`.

**Confirmação:** a documentação orienta tratar o status `approved` como confirmação final do depósito, e recomenda webhook em vez de polling.

**Vantagens:** é a fonte — o emissor do ativo. Split de taxa nativo. Delay programável.
**Limitações:** onboarding por Telegram (não self-service); sem sandbox documentado; sem idempotência; sem SDK.

---

### 1.2 DePix App — gateway sobre o emissor

| Item | Informação |
|---|---|
| Papel | Gateway de pagamento Pix↔DePix, **declaradamente non-custodial** |
| Documentação | [depixapp.com/docs/en](https://depixapp.com/docs/en/) |
| Base URL | `https://api.depixapp.com` |
| Autenticação | `Authorization: Bearer sk_live_<key>` / `sk_test_<key>` |
| Escopos | `merchant_read`, `merchant_write`, `wallet_read`, `wallet_write` |
| **Sandbox** | ✅ **Sim.** `sk_test_` é automático (sem aprovação); respostas marcadas `sandbox: true`, strings `SANDBOX-*-DO-NOT-PAY` impagáveis, e `POST /api/checkouts/:id/simulate-payment` para simular pagamento. Regras de validação reais continuam valendo |
| Produção | `sk_live_` exige **aprovação manual** após onboarding |
| **Idempotência** | ✅ Header `Idempotency-Key` (1–255 ASCII) em `/api/deposit`, `/api/withdraw`, `/api/checkouts`. TTL 24 h; replay marcado com `Idempotency-Replayed: true` |
| **Webhooks assinados** | ✅ HMAC-SHA256 — ver §1.3 |
| MCP oficial | [github.com/depixapp/depix-mcp](https://github.com/depixapp/depix-mcp) — open-source |
| Correlação | Header `X-Request-Id` em todas as respostas |

**Endpoints documentados**

| Grupo | Endpoints |
|---|---|
| Checkouts | `POST /api/checkouts`, `GET /api/checkouts/:id`, `GET /api/checkouts`, `POST /api/checkouts/:id/simulate-payment` |
| Depósito (on-ramp) | `POST /api/deposit`, `GET /api/deposits/:id` |
| Saque (off-ramp) | `POST /api/withdraw`, `GET /api/withdrawals/:id` |
| Produtos/cobranças | `POST /api/products`, `PATCH /api/products/:id`, `GET /api/products` |

**Trilho DePix direto:** checkout com `payment_method: depix` gera endereço Liquid + valor exato + URI de pagamento, sem QR Pix. Estados: `pending` → `approved` (1ª confirmação, ~1 min) → `completed` (2ª confirmação).

**`POST /api/withdraw` — o fluxo non-custodial**

Requisição: `pixKey`, `depositAmountInCents` **ou** `payoutAmountInCents` (mutuamente exclusivos), `taxNumber` (CPF/CNPJ do titular da chave), `refundAddress` (opcional — **na prática, obrigatório para nós**).

Resposta: `withdrawalId`, `depositAddress`, `depositAmountInCents`, `payoutAmountInCents`, `totalDepositAmountInCents`, `fee_cents`, `fee_address`.

⚠️ **A API não devolve transação para assinar.** O cliente monta a transação Liquid: DePix para `depositAddress` (saída confidencial) **e** `fee_cents` para `fee_address` como **saída explícita não-blindada** no mesmo asset DePix. A documentação avisa que pagar a taxa de forma blindada *"makes the withdrawal fail and can lose the funds"*. Estados: `unsent` → `sending` → `sent`.

**Taxas documentadas**

| Operação | Taxa |
|---|---|
| Depósito (Pix→DePix) | 2% + R$ 0,99 |
| Saque ≤ R$ 100 | 1% + R$ 1,00 |
| Saque > R$ 100 | 2% |

**Limites documentados**

- **Por chave com `wallet_write`:** padrão R$ 100,00 por transação (10.000 centavos) e R$ 500,00 por 24 h (50.000 centavos) — limites de gasto obrigatórios.
- **Rate limit:** depósito/saque 20/min por IP e 2/min por chave; checkout público 10/min por IP; agregado por merchant 30/min (configurável).
- **Velocidade do pagador:** máximo **2 QRs por CPF/CNPJ a cada 30 minutos** (depósitos + checkouts somados).
- **Conta:** exigência de primeiro depósito, tetos por transação, teto móvel de recebimento e teto diário/acumulado, dependentes de verificação.

**Regras de compliance do provider**

- Depósitos pessoais contam para a verificação da conta; checkouts não contam.
- O **primeiro saque precisa bater com o CPF/CNPJ do primeiro depósito concluído**, salvo conta já verificada ou chaves de teste.

**Vantagens:** sandbox de verdade, idempotência, webhooks assinados, non-custodial por design, erros estruturados por código, MCP oficial open-source.
**Limitações:** `sk_live_` depende de aprovação; **sem consulta DICT** (ver §3); limites por chave baixos por padrão.

---

### 1.3 Verificação de webhook (DePix App) — implementar exatamente assim

Headers:

| Header | Conteúdo |
|---|---|
| `X-DePix-Signature` | `t=<timestamp>,v1=<hmac_sha256_hex>` |
| `X-DePix-Event` | nome do evento (ex.: `checkout.completed`) |
| `X-DePix-Event-Id` | identificador estável entre retentativas — **chave de dedupe** |

Verificação: `HMAC-SHA256(webhook_secret, "{timestamp}.{raw_body}") == v1`.

⚠️ Usar os **bytes brutos** do corpo antes de qualquer parse de JSON. Reserializar invalida a assinatura. Comparação em tempo constante. Rejeitar timestamps fora de janela aceitável (proteção contra replay).

Entrega **at-least-once**, com 6 tentativas ao longo de ~17 h. Dedupe por `X-DePix-Event-Id` é obrigatório.

Eventos: `checkout.processing`, `checkout.approved`, `checkout.completed`, `checkout.cancelled`, `checkout.expired`, `checkout.unmatched_payment`, `deposit.*`, `withdraw.*`.

---

### 1.4 Comparação e recomendação

| Critério | Eulen | DePix App |
|---|---|---|
| Sandbox | ❌ não documentado | ✅ sim |
| Idempotência | ❌ | ✅ |
| Webhook assinado | ⚠️ não documentado o esquema | ✅ HMAC-SHA256 |
| Non-custodial no saque | ⚠️ não explícito | ✅ explícito |
| Onboarding | Telegram | Self-service (teste) + aprovação (produção) |
| Taxas publicadas | ❌ não encontradas | ✅ |
| Limites publicados | ⚠️ parciais | ✅ detalhados |

> **Recomendação: DePix App como provider primário; Eulen como segundo adapter.**
> A razão é técnica, não comercial: sandbox e idempotência são pré-requisitos das seções 21, 34 e 43 dos requisitos. Sem sandbox, não há como desenvolver sem dinheiro real. Ambos ficam atrás da interface `DepixProvider`.

---

## 2. Ativo e rede

### 2.1 DePix (o ativo)

| Item | Valor |
|---|---|
| Asset ID | `02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189` |
| Rede | Liquid Network mainnet |
| Precisão | 8 |
| Emissor | Eulen.app LLC |
| Verificação | On-chain via [Esplora](https://blockstream.info/liquid/api/asset/02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189) — `entity.domain = depix.info`, ticker `DePix` |
| Carteiras com suporte | SideSwap, Blockstream Green, Aqua (JAN3), e qualquer carteira Liquid |
| KYC | *"KYC requirements depend on the independent entity or platform you use to acquire or redeem DePix"* — [depix.info](https://depix.info/) |

### 2.2 Bibliotecas Liquid (versões verificadas no npm em ago/2026)

| Biblioteca | Versão | Licença | Uso |
|---|---|---|---|
| [LWK — Liquid Wallet Kit](https://github.com/Blockstream/lwk) (`lwk_wasm`) | `0.18.0` | MIT | **Escolhida.** Blockstream; bindings Rust/WASM/Python/Kotlin/Swift; hardware wallet (Jade, Ledger) |
| [liquidjs-lib](https://github.com/vulpemventures/liquidjs-lib) | `6.0.2-liquid.38` | — | Construção fina de transação; necessária para a saída de taxa não-blindada |
| [Breez SDK Nodeless](https://sdk-doc-liquid.breez.technology/) (`@breeztech/breez-sdk-liquid`) | `0.12.4` | — | Alternativa futura; suporta ativos Liquid arbitrários via `asset_metadata` |

### 2.3 Indexação

| Serviço | Endpoint | Observação |
|---|---|---|
| Blockstream Esplora (Liquid) | `https://blockstream.info/liquid/api` | Verificado funcionando; usado para consulta de asset, UTXO e confirmações |

⚠️ Com Confidential Transactions, o explorer sozinho não revela valores. Detectar depósitos exige a *master blinding key* em modo watch-only — daí a escolha do LWK no servidor de monitoramento.

---

## 3. Providers Pix diretos — quando (e se) precisamos

**Para os fluxos 1 e 2, um provider Pix separado não é necessário:** o operador DePix já cobre cobrança, webhook e payout Pix de ponta a ponta.

Há **uma** funcionalidade dos requisitos que o operador não entrega:

> Seção 8 — exibir **nome e instituição do recebedor** após digitar a chave Pix, antes de confirmar.

Isso depende de consulta ao **DICT** (diretório de chaves do Pix), acessível apenas a instituições participantes do arranjo ou por meio delas. **Nenhum dos dois operadores DePix documenta esse endpoint.**

Portanto: `PixProvider.getRecipient()` e `PixProvider.validatePixKey()` ficam definidos na interface e marcados **INTEGRAÇÃO PENDENTE**. Ligá-los exige contratar uma instituição/provider Pix com acesso ao DICT — decisão comercial que **não bloqueia** as ETAPAS 2 e 3.

**Enquanto isso, a mitigação real** (já descrita em ARCHITECTURE.md §4): `refundAddress` sempre preenchido com endereço do próprio usuário + tela de revisão que mostra a chave digitada em destaque e informa honestamente que a validação ocorre na liquidação.

> **Nota metodológica:** a pesquisa sobre provedores Pix brasileiros (Efí, Woovi/OpenPix, Asaas, Banco Inter, Stark Bank, Transfeera e outros) **não foi concluída** nesta rodada — os agentes de pesquisa correspondentes falharam por indisponibilidade do serviço e a integração não é caminho crítico para as ETAPAS 2 e 3. Esta seção será preenchida com dados verificados **antes** de qualquer decisão de contratação. Não listamos capacidades, custos ou endpoints desses provedores aqui porque não foram verificados — e a regra 43 proíbe preencher lacuna com suposição.

---

## 4. Lightning e swaps

### 4.1 Boltz — verificado ao vivo

`GET https://api.boltz.exchange/v2/swap/submarine` respondeu com os pares:

| Par | Limites (sat) | Taxa |
|---|---|---|
| BTC → BTC | 25.000 – 25.000.000 | 0,1% + 378 sat |
| **L-BTC → BTC** | 1.000 – 25.000.000 (zero-conf até 1.000.000) | 0,1% + 19 sat |
| ARK → BTC | 333 – 2.000.001 | 0,1% |

**Somente ativos denominados em bitcoin. Nenhum ativo Liquid além do L-BTC.** Boltz não faz DePix ↔ Lightning.

### 4.2 SideSwap

- [Anúncio da parceria DePix](https://sideswap.io/news/depix-partnership/): atomic swaps não-custodiais **DePix ↔ L-BTC** na Liquid.
- API pública documentada em [sideswap.io/docs](https://sideswap.io/docs/#sideswap-api-documentation); cliente open-source em [github.com/sideswap-io/sideswapclient](https://github.com/sideswap-io/sideswapclient).
- Par DePix/USDT: **não documentado** no anúncio.

### 4.3 Taproot Assets — não aplicável ao DePix

[Taproot Assets](https://docs.lightning.engineering/the-lightning-network/taproot-assets) (Lightning Labs) emite e roteia ativos no **Bitcoin mainnet**. DePix é emitido na **Liquid**. São protocolos distintos em cadeias distintas; não há ponte documentada.

Uma página de glossário de terceiros afirma que DePix estaria "disponível através do ecossistema" Taproot Assets. **Não confirmado** — a documentação oficial do DePix não menciona Lightning nem Taproot Assets, e o registro on-chain mostra emissão na Liquid. Tratado como não disponível.

### 4.4 Breez SDK Nodeless

Suporta ativos Liquid arbitrários via `asset_metadata` (asset ID, nome, ticker, precisão) — DePix caberia. Faz swaps entre ativos Liquid. Mas a [documentação](https://sdk-doc-liquid.breez.technology/guide/assets.html) confirma que **pagar invoice Lightning em BTC a partir de saldo em ativo não-BTC não é suportado**.

### 4.5 Conclusão sobre Lightning

| Caminho | Status |
|---|---|
| DePix nativo por Lightning | 🔴 Não existe |
| DePix via Taproot Assets | 🔴 Não existe (cadeia e protocolo diferentes) |
| LN(BTC) → L-BTC (Boltz) → DePix (SideSwap) | 🟡 Cada perna é real, mas expõe o usuário ao preço do BTC entre as pernas |

Ver ARCHITECTURE.md §5 para a decisão de produto.

---

## 5. Outras integrações encontradas

| Projeto | O que é | Fonte |
|---|---|---|
| BTCPay Server plugin DePix | Permite lojistas aceitarem Pix convertido em DePix | [github.com/thgO-O/btcpayserver-plugin-depix](https://github.com/thgO-O/btcpayserver-plugin-depix) |
| depix-mcp | Servidor MCP oficial do DePix App | [github.com/depixapp/depix-mcp](https://github.com/depixapp/depix-mcp) |
| eulen-repo/DePix | Repositório do token/whitepaper | [github.com/eulen-repo/DePix](https://github.com/eulen-repo/DePix) |

---

## 6. Matriz de decisão

| Necessidade | Escolha | Status |
|---|---|---|
| Rampa Pix→DePix | DePix App (Eulen como 2º adapter) | 🟡 Sandbox já; produção requer aprovação |
| Rampa DePix→Pix | DePix App | 🟡 Idem |
| Carteira Liquid non-custodial | LWK (`lwk_wasm`) | 🟢 Disponível |
| Montagem fina de transação | liquidjs-lib | 🟢 Disponível |
| Indexação/confirmações | Blockstream Esplora | 🟢 Disponível |
| Swap DePix↔L-BTC | SideSwap | 🟢 Documentado (não priorizado) |
| Lightning | — | 🔴 Indisponível para DePix |
| Consulta DICT (nome do recebedor) | — | 🔴 **INTEGRAÇÃO PENDENTE** |
