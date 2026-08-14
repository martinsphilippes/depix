# Carteira DePix — sistema Pix ↔ DePix

Carteira em reais para o usuário final. Por baixo: DePix na Liquid Network, autocustódia e rampa fiat via operador autorizado.

> **Estado: ETAPA 2 concluída; ETAPA 3 em andamento.** Núcleo financeiro, banco, ledger, adapters, workers, carteira com assinatura no dispositivo, API, interface, conciliação automática e painel administrativo.
> **Nenhum fundo real é movimentado.** A aplicação recusa subir em produção sem liberação explícita.

```
373 testes · 373 passando · 1 suíte opt-in (rede real)
```

**Banco: Cloud Firestore.** A migração do PostgreSQL mudou o modelo de
garantias do ledger — leia [DATABASE.md §2](docs/DATABASE.md) antes de mexer
nele.

---

## Começando

```bash
npm install
cp .env.example .env          # ajuste IP_HASH_SALT
npm test                      # sobe o emulador do Firestore e roda tudo
npm run smoke:api             # sobe a API de verdade e bate nas rotas por HTTP
npm run demo                  # percorre o sistema num navegador e salva as telas
npm run smoke:web             # abre o app num Chromium e gera uma carteira
npm run smoke:pwa             # confere manifesto, service worker e offline
npm run test:testnet          # envio real na Liquid testnet (usa faucet)

# desenvolvimento (dois terminais)
npm run emulator                      # Firestore → localhost:8080
npm run bootstrap                     # ativos, contas de sistema, providers
npm run bootstrap -- admin <userId>   # concede acesso ao painel (não há rota HTTP para isso)
npm run dev --workspace=@depix/api    # API      → localhost:3001
npm run worker                        # worker das filas
npm run dev --workspace=@depix/web    # UI       → localhost:3000
```

`npm test` usa `firebase emulators:exec`, que sobe o emulador, roda a suíte e
o derruba. Não precisa de servidor de banco nem de Docker — só de Java, que o
emulador exige.

---

## Estrutura

| Pacote | Responsabilidade |
|---|---|
| `packages/core` | Domínio puro: dinheiro, ativos, taxas, máquina de estados, idempotência |
| `packages/firestore` | Cliente, modelo de documentos, bootstrap e harness de teste |
| `packages/ledger` | Partidas dobradas, saldos, proteção contra gasto duplo |
| `packages/providers` | Adapters: DePix App, sandbox, Esplora, Pix e Lightning pendentes |
| `packages/wallet` | **Chaves, assinatura e validação pré-transmissão — roda no dispositivo do usuário** |
| `packages/app` | Autenticação, fluxos de negócio, extrato, webhooks, workers |
| `apps/api` | HTTP (Fastify), gate de ambiente, processo do worker |
| `apps/web` | Interface (Next.js) |

Telas: entrar, carteira (criar/restaurar com backup conferido), início, receber, enviar, extrato, contatos, avisos, ajustes e painel.

---

## As decisões que sustentam o resto

**Dinheiro é `bigint` em unidade mínima, amarrado ao ativo.** Somar centavos com unidades de DePix levanta `asset_mismatch` em vez de produzir um número plausível e errado. Nenhuma quantia é float — o Firestore guarda inteiros de 64 bits nativos e o SDK os devolve como `bigint`.

**Saldo vem do ledger, nunca da soma do histórico.** Partidas dobradas, lançamentos append-only, e um saldo que é projeção escrita na **mesma transação** dos lançamentos. Correção é lançamento de ajuste, com motivo e ator registrados.

**Gasto duplo é impedido pela concorrência otimista do Firestore.** Uma transação que leu um saldo e o vê mudar é reexecutada, então a segunda tentativa relê o saldo já debitado. Verificado com dois envios simultâneos do saldo inteiro, dez tentativas em paralelo, e vinte créditos concorrentes.

**Idempotência é constraint do banco, não verificação em código.** O ID do documento **é** a chave de idempotência, e `create()` falha com `ALREADY_EXISTS`. A corrida perdida é tratada como sucesso. A checagem de chave vem **antes** da validação de saldo, para que o retry de uma operação já efetivada não falhe por saldo insuficiente.

**A conciliação é parte do mecanismo, não conferência de rotina.** No PostgreSQL um trigger impedia a projeção de divergir dos lançamentos. O Firestore não tem triggers, e suas regras de segurança não se aplicam ao Admin SDK — verificado, não presumido. Então `reconcileAccount()` recomputa o saldo a partir dos lançamentos e é o que **detecta** qualquer escrita feita por fora do ledger. Há teste que adultera o saldo e verifica a detecção.

**`COMPLETED` só é alcançável a partir de `CONFIRMING`.** Não há atalho. Um HTTP 200 move a transação no máximo até "confirmando"; quem conclui é o worker que verificou confirmação real. Webhook isolado não tem essa autoridade — há teste para isso.

**Dinheiro é exato mesmo no Firestore.** `useBigInt` faz o SDK devolver inteiros de 64 bits como `bigint`; sem isso, valores acima de 2^53 perderiam precisão silenciosamente. A contrapartida é que **todo** inteiro volta como bigint, inclusive contadores — daí a normalização explícita, e um teste que varre a resposta HTTP procurando bigint (que faria `JSON.stringify` lançar).

**Autocustódia.** Não existe campo de seed, xprv ou chave privada — e um teste varre os documentos gravados e falha o build se algum aparecer. O servidor guarda apenas o descriptor watch-only: vê saldo, não assina. Um comprometimento total do servidor não move os fundos dos usuários.

**A transação é validada saída por saída antes de ser assinada.** O saque exige que a taxa do operador seja paga numa saída explícita (não-blindada); pagá-la blindada, segundo a documentação do provider, faz a operação falhar e pode perder os fundos. O guard é função pura sobre formas de saída — testado exaustivamente, sem rede e sem carteira financiada — e **aborta em vez de transmitir**. Ele também recusa saída explícita onde ela não deveria existir, porque explícito na Liquid significa valor visível na cadeia.

**Verificação de webhook recebe `Buffer`, não objeto.** Reserializar o JSON antes de conferir a assinatura é o erro clássico da integração; a assinatura do tipo torna esse erro impossível de cometer por descuido, e há teste de regressão provando que o corpo reserializado é rejeitado.

**O PWA não guarda uma única resposta da API em cache.** É o oposto do que quase todo tutorial ensina, e a razão é que um saldo em cache é uma mentira sobre dinheiro: quem vê R$ 1.200 num aplicativo offline e conclui que pode gastar não foi ajudado, foi enganado. O service worker guarda só os arquivos estáticos — que têm hash no nome e são imutáveis — e serve uma tela honesta de "sem conexão" quando falta rede. Há verificação automática de que nenhuma URL da API aparece no cache e de que a tela offline não exibe valor nenhum.

**Há teste que abre um navegador de verdade, e ele já pagou por si.** `npm run smoke:web` sobe o app num Chromium, gera uma carteira e cifra um cofre. Foi assim que se descobriu que a CSP — declarada como cabeçalho estático, com build e testes passando — bloqueava os scripts de hidratação do Next e entregava ao usuário uma página **sem um único botão funcionando**. Nenhum teste de unidade pegaria isso: CSP só é aplicada por navegador. A correção é nonce por requisição em `middleware.ts`, que não abre mão da proteção.

**O envio já rodou contra a rede de verdade.** Uma transação real foi montada, assinada e transmitida na Liquid testnet pelo mesmo `executeSend` que a tela chama, e o destinatário recebeu o valor exato. O teste está em `packages/wallet/test/testnet.integration.test.ts`, opt-in por `LIQUID_TESTNET_E2E=yes` — depende de faucet e de rede externa, e uma suíte instável é uma suíte que as pessoas aprendem a ignorar. Sem a variável ele reporta SKIP com o motivo, nunca passa em silêncio.

**A transação sai do dispositivo direto para a rede.** O envio é: destravar o cofre → sincronizar UTXOs → montar → validar → assinar → conferir → transmitir → só então avisar o servidor. A ordem é código, não disciplina de quem escreve a tela, e há teste que injeta uma falha de rede e prova que nada foi assinado antes da sincronização. O servidor fica sabendo do envio **depois**, pelo txid; se essa chamada falhar, o dinheiro já andou e a tela diz isso em vez de fingir que o envio não aconteceu.

**A frase de recuperação fica cifrada em repouso, com uma chave que não existe em lugar nenhum.** PBKDF2-SHA256 de 600 mil iterações sobre o PIN do usuário, AES-256-GCM, e a chave derivada é `extractable: false`. O que garante: quem copiar o `localStorage` não tem a frase. O que **não** garante, e está escrito no módulo: proteção contra código malicioso rodando na página enquanto o cofre está aberto — nesse instante a chave está em memória, porque assinar exige a chave. Daí a CSP e a regra de descartar o signer no `finally`. Há teste que serializa o cofre e falha se qualquer uma das 12 palavras aparecer.

**A passkey é o único fator, e não há senha nenhuma.** Sem senha não há o que phishar, reusar ou vazar do servidor: o banco guarda chave pública, ID e contador — material inútil para quem o roubar. O challenge é de uso único e consumido **antes** da verificação, inclusive quando ela falha, então uma assinatura capturada não vira login. Contador que retrocede é credencial clonada e a autenticação é recusada com registro em auditoria. O preço, assumido: perder todos os autenticadores é perder a conta — não há e-mail de recuperação porque não coletamos e-mail. O dinheiro é separado desse risco pelo backup de 12 palavras, e a API recusa apagar a última passkey. Os testes usam um autenticador ECDSA P-256 de software real, verificado pela mesma biblioteca de produção — inclusive o teste que simula phishing assinando de outra origem.

**A conciliação roda sozinha, e isso não é zelo.** No PostgreSQL um gatilho tornava impossível a projeção de saldo divergir dos lançamentos. O Firestore não tem gatilho, então a garantia deixou de ser prevenção e virou detecção — e uma detecção que não roda transforma "o saldo vem do ledger" em esperança. O worker concilia a cada 15 minutos e **registra a rodada mesmo quando não acha nada**: saber que a verificação rodou e estava tudo certo é diferente de não ter notícia dela. Nenhuma divergência é corrigida automaticamente; vira achado aberto, e fechá-lo exige escrever o que foi verificado.

**Trocar o endereço de um contato pede passkey; renomear, não.** A distinção é o ponto inteiro. Trocar o endereço de um contato conhecido e mandar em seguida é o roteiro do ataque de quem já tomou a sessão — a vítima confere o nome, não os 100 caracteres. Mas se corrigir uma digitação também pedisse confirmação, o usuário aprenderia a clicar sem ler, que é justamente o hábito que o aviso deveria quebrar.

**Os controles estão no caminho da requisição, não só no repositório.** Rate limiting (por conta e por IP, com modo de força bruta e modo de throttling), reautenticação para operação sensível, e limites por usuário verificados **dentro do serviço** — não na rota, porque limite checado só no handler HTTP deixa de valer para worker e reprocessamento. Há testes que provam a fiação pela API, não pelo módulo.

**A aplicação não sobe em configuração perigosa.** `sk_live_` fora de produção, sandbox em produção, ou produção sem `ENABLE_REAL_FUNDS=yes` derrubam o boot. E — específico do Firestore — desenvolvimento apontado para o projeto real sem confirmação explícita também derruba: a diferença entre banco de brincadeira e banco de produção aqui é uma variável de ambiente, e a suíte de testes apaga todos os documentos.

---

## Os quatro fluxos

| Fluxo | Status | Onde está |
|---|---|---|
| **Pix → DePix** | 🟡 sandbox funcionando; produção requer aprovação | `packages/app/src/services/deposit.ts` |
| **DePix → Pix** | 🟡 cotação, construção da transação e guard prontos; falta credencial do operador | `packages/wallet/src/transactions.ts` |
| **DePix → DePix (Liquid)** | 🟢 completo e **provado na testnet**: tela → cofre → assinatura no dispositivo → transmissão | `packages/wallet/`, `apps/web/app/enviar/` |
| **DePix → DePix (Lightning)** | 🔴 indisponível | `packages/providers/src/lightning/unavailable.ts` |

Justificativa de cada classificação em [ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## O que ainda não existe — e está dito no código

Nenhuma dessas lacunas é simulada. Todas lançam `IntegrationPendingError` explicando do que dependem:

| Lacuna | Consequência |
|---|---|
| **Consulta DICT** (nome do dono da chave Pix) | A tela de envio não mostra o nome do recebedor. Mitigação: endereço de estorno sempre preenchido + confirmação explícita da chave |
| **Lightning para DePix** | Cadeias e protocolos diferentes, sem ponte. Botão presente e desabilitado, com o motivo |
| **Contrato de depósito do operador** | Mapeamento isolado em `mapDeposit*`, marcado para verificação em sandbox antes de qualquer uso real |
| **Leitura de QR no Safari e no Firefox de desktop** | Usamos a `BarcodeDetector` do navegador em vez de uma biblioteca de terceiros — código externo lendo os quadros da câmera, na mesma origem que segura a seed, não vale a conveniência. Onde ela falta, o botão não aparece e o campo de colar continua ali |

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [RODANDO.md](docs/RODANDO.md) | **Como subir e percorrer o sistema na sua máquina** |
| [DATABASE.md](docs/DATABASE.md) | **Modelo Firestore e o que mudou nas garantias do ledger** |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Discovery, os 4 fluxos, decisão de custódia, riscos |
| [PROVIDERS.md](docs/PROVIDERS.md) | Operadores, bibliotecas, Lightning — com fontes |
| [REGULATORY_ARCHITECTURE.md](docs/REGULATORY_ARCHITECTURE.md) | Perímetro regulatório e os 10 pontos de validação jurídica |
| [SECURITY.md](docs/SECURITY.md) | Modelo de ameaças, custódia, testes obrigatórios |

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
4. revisão de segurança e suíte financeira passando;
5. rotina de conciliação em execução com alarme — no Firestore ela deixou de
   ser conferência de rotina e passou a ser parte da garantia do ledger.
