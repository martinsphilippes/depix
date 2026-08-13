# REGULATORY_ARCHITECTURE.md — Análise técnica de perímetro regulatório

> ⚠️ **Este documento não é parecer jurídico.** É uma análise **técnica** de quais funções do sistema podem tocar atividades reguladas, escrita por quem projeta o software, para orientar decisões de arquitetura e delimitar o que precisa de validação jurídica antes de produção.
> **Nenhuma operação com dinheiro real deve ser habilitada antes da validação da seção 5 por advogado especializado.**

---

## 1. Premissa arquitetural

O código **não assume, em nenhum ponto, que podemos ser participantes diretos do Pix.**

Participação no arranjo Pix é privativa de instituições autorizadas pelo Banco Central. Nossa arquitetura acessa o Pix **exclusivamente por meio de um operador autorizado**, via API. Isso está refletido no código: não existe integração com o SPI, não existe conta de liquidação nossa, e a interface `PixProvider` sempre representa um terceiro.

A pergunta que este documento responde é: **o que sobra sob nossa responsabilidade, e o que isso caracteriza?**

---

## 2. Decomposição funcional por natureza

Cada função do sistema classificada em uma de quatro categorias.

### 2.1 🟢 Tecnologia pura — não caracteriza atividade regulada por si só

| Função | Por quê |
|---|---|
| Gerar par de chaves e endereços Liquid no dispositivo | Criptografia local; nenhum ativo de terceiro é tocado |
| Exibir saldo lendo a blockchain pública | Leitura de dado público |
| Montar transação Liquid não assinada | Software; sem posse nem controle |
| Ler QR Code e detectar tipo | Parsing |
| Transmitir transação já assinada pelo usuário | Relay de dado público; qualquer nó da rede faz isso |
| Ledger interno, extrato, conciliação, notificações | Contabilidade e UX internos |
| Backup criptografado no dispositivo | Criptografia local |

**A carteira non-custodial pura (fluxo 3, DePix→DePix) vive inteiramente aqui.** Um usuário que só faz isso não interage com nenhum sistema financeiro regulado através de nós.

> ⚠️ **Ressalva honesta:** "não caracteriza por si só" ≠ "está fora de qualquer regulação". Prestadores de serviço de ativos virtuais são regulados no Brasil pela Lei 14.478/2022, e o Banco Central vem detalhando o regime. A questão central para a maioria das definições é **custódia e intermediação** — que evitamos por design. Se o entendimento aplicável alcançar também software não-custodial, isso é fato jurídico e a resposta é conformar-se, não contornar (seção 43 dos requisitos).

### 2.2 🟡 Exige parceiro autorizado — e já está desenhado assim

| Função | Quem executa |
|---|---|
| Receber Pix e gerar cobrança (QR dinâmico) | **Operador DePix** (conta e arranjo dele) |
| Converter BRL → DePix | **Emissor/operador** |
| Converter DePix → BRL | **Operador** |
| Enviar Pix ao recebedor final | **Operador** |
| Consultar DICT (nome/instituição da chave) | **Instituição participante** — hoje INTEGRAÇÃO PENDENTE |
| Screening de compliance / sanções | **Operador** (HTTP 422 da Eulen é exatamente isso) |

Nós **solicitamos** e **exibimos**. Não executamos. A fronteira é literal no código: tudo isso está atrás de `DepixProvider` / `PixProvider`, e nenhuma dessas operações tem implementação própria nossa.

### 2.3 🟠 Pode exigir autorização — depende de decisões que ainda não tomamos

Estas são as funções onde uma escolha de implementação pode nos empurrar para dentro do perímetro. Estão listadas para serem **evitadas conscientemente**, não descobertas depois.

| Função | Risco | Nossa decisão |
|---|---|---|
| **Custódia de ativos de usuários** | Guardar chave privada de terceiro é a atividade que mais claramente atrai regime de VASP | ❌ **Não fazemos.** Non-custodial; sem coluna de seed/xprv no banco; sem caminho de assinatura remota |
| **Saldo custodial em conta interna** | Passar a dever reais/DePix ao usuário cria relação de depósito | ❌ **Não fazemos.** O ledger reflete ativos on-chain do usuário; não somos contraparte |
| **Intermediação/câmbio por conta própria** | Comprar e vender ativo com spread próprio caracteriza intermediação | ❌ **Não fazemos.** A cotação e a conversão são do operador; nossa taxa é de **serviço de software**, exibida separadamente |
| **Pooling de fundos (conta ômnibus)** | Misturar fundos de usuários é custódia agravada | ❌ **Não fazemos.** Cada usuário tem endereços próprios |
| **Cobrar taxa sobre a conversão** | Pode ser lido como participação na operação de câmbio | ⚠️ **A validar juridicamente.** Estruturado como taxa de uso de software, separada da taxa do provider |
| **Split de taxa via API do operador** | A Eulen oferece `splitFee`/`depixSplitAddress` | ⚠️ **Não usar** sem validação jurídica — muda a natureza econômica do nosso papel |
| **Operar como marketplace/PSP para lojistas** | Receber em nome de terceiros | ❌ Fora de escopo nesta fase |

### 2.4 🔴 Fora de escopo — não implementar

| Função | Motivo |
|---|---|
| Participação direta no Pix / conexão ao SPI | Privativo de instituição autorizada |
| Emissão de DePix | Do emissor (Eulen) |
| Conta de pagamento própria | Exige autorização |
| Qualquer mecanismo de contorno de KYC/AML do operador | **Proibido pela seção 43 dos requisitos e pela lei** |
| Mixing, coinjoin, ofuscação de origem | Não é privacidade por minimização de dados — é ocultação, e nos coloca no lado errado da linha |

---

## 3. A distinção que sustenta a arquitetura

Há uma diferença material entre **não coletar dados desnecessários** e **ajudar alguém a escapar de identificação obrigatória**. A seção 18 dos requisitos pede a primeira; a seção 43 proíbe a segunda. Elas são compatíveis, e a arquitetura mantém as duas:

| Fazemos | Não fazemos |
|---|---|
| Não pedimos CPF para gerar uma carteira | Não escondemos o usuário do operador quando ele faz um Pix |
| Não montamos banco de identidade financeira | Não fragmentamos valores para driblar limites |
| Direcionamos KYC do provider para o próprio provider (hosted) | Não intermediamos documentos para "facilitar" |
| Guardamos apenas status + token opaco | Não desligamos screening do operador |
| Não perguntamos a finalidade da transação | Não removemos controle antifraude para simplificar |

**Em resumo:** quando o operador exige identificação, essa exigência é cumprida — diretamente entre usuário e operador. Nós apenas não duplicamos os dados no nosso banco.

---

## 4. Onde os dados pessoais ficam

```
┌──────────┐   dados pessoais exigidos    ┌──────────────────┐
│ USUÁRIO  │ ──────────────────────────▶ │ OPERADOR DEPIX   │
└──────────┘   (hosted / redirect)        │ (autorizado)     │
     │                                     └──────────────────┘
     │ pseudônimo                                  │
     │ (uuid, endereço público)                    │ status opaco
     ▼                                             ▼ ("authorized")
┌────────────────────────────────────────────────────────────┐
│  NOSSA APLICAÇÃO                                           │
│  ▸ NÃO armazena: nome, CPF, RG, endereço, renda,           │
│    documentos, selfie, biometria, finalidade                │
│  ▸ armazena: uuid, endereço público, txid, asset,          │
│    valores, timestamps, status, token opaco do provider    │
└────────────────────────────────────────────────────────────┘
```

**Exceção documentada e inevitável:** o `POST /api/withdraw` exige `taxNumber` (CPF/CNPJ do titular da chave Pix) como parâmetro. Não há como executar um saque sem esse campo — é requisito do operador.

Aplicando o teste da seção 18.13:

1. *Por que precisamos?* Não precisamos — o **operador** precisa.
2. *O que deixa de funcionar sem ele?* O saque DePix→Pix.
3. *O provider pode armazenar?* Sim, e armazena.
4. *Podemos usar token opaco?* Não na chamada — mas **podemos não persistir**.
5. *Podemos executar sem coletar?* Não.

**Decisão:** o `taxNumber` é coletado no momento do saque, transmitido ao operador e **não é persistido no nosso banco**. Não existe coluna para ele. Não vai para log (redaction obrigatória — SECURITY.md). Se o usuário fizer outro saque, digita de novo. Fricção deliberada em troca de não manter base de CPFs.

---

## 5. ⚖️ Lista de validação jurídica obrigatória antes de produção

Nenhum item abaixo deve ser resolvido por engenharia. São perguntas para advogado especializado em regulação financeira/ativos virtuais, **antes** de habilitar `sk_live_`:

1. **Software de carteira non-custodial** que orquestra rampa fiat de terceiro caracteriza prestação de serviço de ativos virtuais sob a Lei 14.478/2022 e a regulamentação do BCB? Sob qual figura?
2. **Cobrança de taxa própria** sobre operações executadas por operador autorizado — é remuneração de software ou participação na operação? Estrutura contratual adequada?
3. **Exibição de saldo em reais** para ativo que é stablecoin: há requisito de disclosure? A UI precisa deixar claro que não é depósito bancário nem tem garantia do FGC? *(Recomendação de engenharia: sim, e isso é barato de implementar — deve constar na carteira independentemente da resposta jurídica.)*
4. **Responsabilidade por erro de chave Pix** quando não temos DICT: alocação de risco, dever de informação, redação da tela de confirmação.
5. **LGPD:** base legal para os dados mínimos retidos; papel de controlador vs. operador na relação com o provider; política de retenção; atendimento a titulares.
6. **Obrigações de prevenção à lavagem** aplicáveis a quem opera software não-custodial: existem deveres próprios de comunicação, ou eles recaem integralmente sobre o operador?
7. **Relatórios fiscais**: há dever de informar operações com ativos virtuais (IN RFB 1.888/2019 e sucessoras) para quem não custodia nem intermedeia?
8. **Termos de uso e contrato com o operador**: o que o contrato do provider nos obriga a fazer (limites, screening, repasse de informação) e isso é compatível com nossa política de dados?
9. **Split de taxa** (`splitFee` da Eulen): usar essa funcionalidade muda nossa classificação?
10. **Não persistir CPF do saque** (§4): há alguma obrigação de retenção que torne essa decisão inviável?

---

## 6. Postura de conformidade adotada

| Princípio | Como aparece no código |
|---|---|
| Não somos participante do Pix | Zero integração com SPI; Pix sempre via `PixProvider` de terceiro |
| Não custodiamos | Sem coluna de seed/xprv; sem assinatura remota; watch-only apenas |
| Não contornamos controles | Erro `422` de compliance vira `MANUAL_REVIEW`, nunca retry; regra de CPF do primeiro saque respeitada |
| Minimizamos dados | Tabela `provider_authorizations` guarda status e token opaco; `kyc_profiles` **não existe** |
| Rastreabilidade sem vigilância | Ledger imutável e auditoria completa das **operações**, sem perfil do **usuário** |
| Inconsistência não vira dinheiro | Divergência de conciliação bloqueia e escala para revisão; nunca envia automaticamente (seção 43) |

---

## 7. Ambientes e gate de produção

| Ambiente | Fundos | Chaves | Liberação |
|---|---|---|---|
| Development | ❌ nenhum | `sk_test_` | Livre |
| Testnet/Sandbox | ❌ nenhum | `sk_test_` | Livre |
| Staging | ❌ nenhum | `sk_test_` | Livre |
| **Production** | ✅ reais | `sk_live_` | **Bloqueado** até: (a) validação jurídica da §5; (b) aprovação do operador; (c) revisão de segurança; (d) suíte de testes financeiros da seção 38 passando |

O gate é técnico, não apenas documental: a configuração de produção falha ao iniciar se `sk_live_` estiver presente sem a flag explícita de liberação registrada. Cumpre a seção 34 — nunca fundos reais em desenvolvimento sem configuração explícita.
