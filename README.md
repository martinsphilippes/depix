# Carteira DePix — sistema Pix ↔ DePix

Carteira em reais para o usuário final. Por baixo: DePix na Liquid Network, autocustódia e rampa fiat via operador autorizado.

> **Estado atual: ETAPA 1 — Discovery técnico concluído.**
> Nenhum código de integração foi escrito ainda. Nenhuma credencial de produção existe. Nenhum fundo real é movimentado.

---

## Documentos desta etapa

| Documento | Conteúdo |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagnóstico técnico, os 4 fluxos classificados, decisão de custódia, stack, riscos |
| [PROVIDERS.md](docs/PROVIDERS.md) | Operadores DePix, bibliotecas Liquid, Lightning/swaps — com fontes |
| [REGULATORY_ARCHITECTURE.md](docs/REGULATORY_ARCHITECTURE.md) | O que é tecnologia, o que exige parceiro, o que precisa de validação jurídica |
| [SECURITY.md](docs/SECURITY.md) | Modelo de ameaças, custódia, integridade financeira, testes obrigatórios |
| [DATABASE.md](docs/DATABASE.md) | Schema PostgreSQL, ledger de partidas dobradas, idempotência, concorrência |

---

## Os quatro fluxos

| Fluxo | Status | Resumo |
|---|---|---|
| **Pix → DePix** | 🟡 mediante parceiro | API real e documentada; sandbox disponível; produção requer aprovação do operador |
| **DePix → Pix** | 🟡 mediante parceiro | API real e **non-custodial**: o operador devolve endereço, o usuário assina no dispositivo |
| **DePix → DePix (Liquid)** | 🟢 possível agora | Sem parceiro. Rede pública, asset ID confirmado on-chain, bibliotecas maduras |
| **DePix → DePix (Lightning)** | 🔴 indisponível | DePix é ativo da Liquid; Taproot Assets é protocolo do Bitcoin mainnet. Não há ponte |

Justificativa completa de cada classificação em [ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Fatos verificados

- **Asset ID do DePix:** `02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189` — Liquid mainnet, precisão 8, emissor Eulen.app LLC. Confirmado no registro on-chain via Esplora.
- **Operadores com API pública:** [DePix App](https://depixapp.com/docs/en/) (sandbox, idempotência, webhooks assinados) e [Eulen](https://docs.eulen.app/) (o emissor).
- **Carteira:** [LWK](https://github.com/Blockstream/lwk) `lwk_wasm 0.18.0`, assinatura no dispositivo do usuário.
- **Lightning:** [Boltz](https://api.boltz.exchange/v2/swap/submarine) suporta apenas BTC, L-BTC e ARK — nenhum ativo Liquid. Consultado ao vivo.

---

## Princípios que o código precisa respeitar

1. **Autocustódia.** Não existe coluna de seed ou chave privada no banco. Não existe assinatura remota. Um servidor comprometido não move fundos de usuário.
2. **Dados mínimos.** Sem nome, CPF, documentos ou perfil financeiro. KYC, quando exigido, é do operador e fica no operador.
3. **Ledger é a verdade.** Saldo deriva de partidas dobradas imutáveis, nunca da soma do histórico.
4. **HTTP 200 não conclui nada.** Transação só é concluída com confirmação real do provider ou da rede.
5. **Nada inventado.** Onde não há API pública, está escrito INTEGRAÇÃO PENDENTE e existe um adapter pronto.

---

## Lacunas conhecidas

| Lacuna | Impacto |
|---|---|
| **Consulta DICT** (nome/instituição do dono da chave Pix) não existe em nenhum operador DePix | A tela de envio de Pix não pode exibir o nome do recebedor. Mitigação: `refundAddress` sempre preenchido + confirmação explícita da chave |
| Credencial de produção depende de aprovação manual | Desenvolvimento inteiro em sandbox |
| Pesquisa de provedores Pix diretos não concluída | Não bloqueia as próximas etapas; será feita antes de qualquer contratação |

---

## Próximas etapas

**ETAPA 2** — autenticação (passkeys), banco, ledger, dashboard, carteira, histórico, providers abstratos, modo sandbox.
**ETAPA 3** — integração real em sandbox, na ordem: DePix/Liquid → recebimento Pix → Pix→DePix → DePix→Pix.

---

## Ambientes

| Ambiente | Fundos reais |
|---|---|
| Development / Testnet / Staging | ❌ nunca |
| Production | ✅ — bloqueado até validação jurídica, aprovação do operador e revisão de segurança |
