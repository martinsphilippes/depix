# Carteira DePix — sistema Pix ↔ DePix

Carteira em reais para o usuário final. Por baixo: DePix na Liquid Network, autocustódia e rampa fiat via operador autorizado.

> **Estado: ETAPA 2 concluída.** Núcleo financeiro, banco, ledger, adapters, API e interface funcionando em sandbox.
> **Nenhum fundo real é movimentado.** A aplicação recusa subir em produção sem liberação explícita.

```
170 testes · 168 passando · 2 pulados (exigem PostgreSQL real)
```

---

## Começando

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL e IP_HASH_SALT
npm run migrate               # aplica as 9 migrações
npm test                      # suíte completa (usa PGlite, sem servidor)

npm run dev --workspace=@depix/api    # API   → localhost:3001
npm run dev --workspace=@depix/web    # UI    → localhost:3000
```

O teste de gasto duplo concorrente exige Postgres de verdade — PGlite tem sessão única e contenção de lock não acontece nele:

```bash
TEST_DATABASE_URL=postgres://... npm run test:concurrency
```

---

## Estrutura

| Pacote | Responsabilidade |
|---|---|
| `packages/core` | Domínio puro: dinheiro, ativos, taxas, máquina de estados, idempotência |
| `packages/db` | Migrações, cliente e harness de teste |
| `packages/ledger` | Partidas dobradas, saldos, proteção contra gasto duplo |
| `packages/providers` | Adapters: DePix App, sandbox, Esplora, Pix e Lightning pendentes |
| `packages/app` | Autenticação, fluxos de negócio, extrato, webhooks |
| `apps/api` | HTTP (Fastify), gate de ambiente |
| `apps/web` | Interface (Next.js) |

---

## As decisões que sustentam o resto

**Dinheiro é `bigint` em unidade mínima, amarrado ao ativo.** Somar centavos com unidades de DePix levanta `asset_mismatch` em vez de produzir um número plausível e errado. Nenhuma coluna monetária é float — há teste que varre o schema e falha o build se aparecer uma.

**Saldo vem do ledger, nunca da soma do histórico.** Partidas dobradas com imutabilidade e balanceamento impostos por trigger. `UPDATE` e `DELETE` em `ledger_entries` levantam exceção; correção é lançamento de ajuste, com motivo e ator registrados.

**Gasto duplo é impedido pelo banco, não por convenção.** Todo débito trava a conta com `SELECT … FOR UPDATE` e recalcula dentro da transação. Um trigger recusa o commit se o saldo do usuário ficaria negativo — mesmo que algum caminho de código esqueça o lock.

**Idempotência é constraint, não verificação.** Código tem race condition; `UNIQUE` não. A corrida perdida é tratada como sucesso. A checagem de chave vem **antes** do lock, para que o retry de uma operação já efetivada não falhe por saldo insuficiente.

**`COMPLETED` só é alcançável a partir de `CONFIRMING`.** Não há atalho. Um HTTP 200 move a transação no máximo até "confirmando"; quem conclui é o worker que verificou confirmação real. Webhook isolado não tem essa autoridade — há teste para isso.

**Autocustódia.** Não existe coluna de seed, xprv ou chave privada — e um teste de schema falha o build se alguém criar uma. O servidor guarda apenas o descriptor watch-only: vê saldo, não assina. Um comprometimento total do servidor não move os fundos dos usuários.

**Verificação de webhook recebe `Buffer`, não objeto.** Reserializar o JSON antes de conferir a assinatura é o erro clássico da integração; a assinatura do tipo torna esse erro impossível de cometer por descuido, e há teste de regressão provando que o corpo reserializado é rejeitado.

**A aplicação não sobe em configuração perigosa.** `sk_live_` fora de produção, sandbox em produção, ou produção sem `ENABLE_REAL_FUNDS=yes` derrubam o boot com mensagem explícita.

---

## Os quatro fluxos

| Fluxo | Status | Onde está |
|---|---|---|
| **Pix → DePix** | 🟡 sandbox funcionando; produção requer aprovação | `packages/app/src/services/deposit.ts` |
| **DePix → Pix** | 🟡 cotação e adapter prontos; falta assinatura no dispositivo | `packages/providers/src/depix/` |
| **DePix → DePix (Liquid)** | 🟢 ledger e fluxo completos; falta assinatura no dispositivo | `packages/app/src/services/send.ts` |
| **DePix → DePix (Lightning)** | 🔴 indisponível | `packages/providers/src/lightning/unavailable.ts` |

Justificativa de cada classificação em [ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## O que ainda não existe — e está dito no código

Nenhuma dessas lacunas é simulada. Todas lançam `IntegrationPendingError` explicando do que dependem:

| Lacuna | Consequência |
|---|---|
| **Consulta DICT** (nome do dono da chave Pix) | A tela de envio não mostra o nome do recebedor. Mitigação: endereço de estorno sempre preenchido + confirmação explícita da chave |
| **Assinatura no dispositivo** (LWK) | Envio para na revisão com o valor já reservado. É a próxima entrega |
| **Lightning para DePix** | Cadeias e protocolos diferentes, sem ponte. Botão presente e desabilitado, com o motivo |
| **Contrato de depósito do operador** | Mapeamento isolado em `mapDeposit*`, marcado para verificação em sandbox antes de qualquer uso real |

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Discovery, os 4 fluxos, decisão de custódia, riscos |
| [PROVIDERS.md](docs/PROVIDERS.md) | Operadores, bibliotecas, Lightning — com fontes |
| [REGULATORY_ARCHITECTURE.md](docs/REGULATORY_ARCHITECTURE.md) | Perímetro regulatório e os 10 pontos de validação jurídica |
| [SECURITY.md](docs/SECURITY.md) | Modelo de ameaças, custódia, testes obrigatórios |
| [DATABASE.md](docs/DATABASE.md) | Schema, ledger, idempotência, concorrência |

---

## Fatos verificados

- **Asset ID do DePix:** `02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189` — Liquid mainnet, precisão 8. Confirmado no registro on-chain via Esplora.
- **Operadores com API pública:** [DePix App](https://depixapp.com/docs/en/) e [Eulen](https://docs.eulen.app/).
- **Boltz** suporta apenas BTC, L-BTC e ARK — nenhum ativo Liquid. Consultado ao vivo.

---

## Antes de produção

O gate técnico (`ENABLE_REAL_FUNDS=yes`) só deve ser destravado depois de:

1. validação jurídica dos 10 pontos de [REGULATORY_ARCHITECTURE.md §5](docs/REGULATORY_ARCHITECTURE.md);
2. aprovação da chave `sk_live_` pelo operador;
3. verificação do contrato de depósito contra o sandbox;
4. revisão de segurança e suíte financeira passando contra Postgres real.
