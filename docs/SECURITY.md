# SECURITY.md — Modelo de segurança

> Sistema financeiro. As regras abaixo são requisitos de implementação, não recomendações.
> Regra que prevalece sobre todas as outras: **na dúvida, não mova dinheiro.**

---

## 1. Modelo de ameaças

| Ator | Capacidade | O que impedimos |
|---|---|---|
| Atacante externo | Rede, força bruta, phishing | Acesso a conta, roubo de sessão, transação não autorizada |
| **Nosso próprio servidor comprometido** | Acesso total ao banco e à aplicação | **Movimentar fundos de usuários** — impossível por design (§2) |
| Insider (admin) | Acesso ao painel | Alteração arbitrária de saldo — impossível (§7) |
| Provider comprometido/malicioso | Respostas e webhooks forjados | Crédito indevido — assinatura + confirmação independente (§5) |
| Usuário adversário | Cliente sob controle total | Gasto duplo, saldo negativo, replay (§6) |

**A propriedade mais importante do sistema:** um comprometimento total do nosso servidor não permite roubar os fundos dos usuários. Ele permite mentir na tela, o que é grave — mas não permite assinar transação. Isso é consequência direta da escolha non-custodial, e é o motivo pelo qual essa escolha vale a complexidade extra.

---

## 2. Chaves e custódia

### Proibições absolutas — verificáveis por teste automatizado

Nunca, em nenhum ambiente, nenhuma dessas coisas sai do dispositivo do usuário ou é persistida:

- seed phrase / mnemônico
- chave privada (xprv) ou qualquer chave de assinatura
- master blinding key **privada**
- senha em texto puro
- recovery secret

**Enforcement:** teste de CI que varre os documentos gravados no Firestore em busca de campos com nomes suspeitos (`seed`, `mnemonic`, `xprv`, `privkey`, `private_key`, `blinding_key`) e falha o build se encontrar. Nenhum endpoint aceita esses campos no corpo da requisição.

### O que o servidor pode saber

Apenas o **descriptor CT watch-only** (`wallets.ctDescriptorEnc`): xpub + master blinding key, o suficiente para **ver** saldo e depósitos, insuficiente para **gastar**.

> ⚠️ **Trade-off declarado honestamente:** a master blinding key desblinda os valores confidenciais do usuário. Quem tem acesso ao nosso banco vê os saldos e as transações desse usuário — não pode movê-los, mas vê. Esse é o preço de detectar depósitos e conciliar no servidor. A alternativa (detecção 100% no cliente) impede conciliação e monitoramento. Escolhemos ver-sem-poder-gastar, e o descriptor é cifrado em repouso (AES-256-GCM, chave em KMS/vault, nunca no código nem no `.env` de produção).

### Assinatura

Sempre no dispositivo, via `lwk_wasm`. **Não existe endpoint de assinatura remota.** Não existe fluxo em que o servidor produza uma transação assinada.

### 2.1 O cofre local

A frase precisa sobreviver entre sessões — ninguém digita 12 palavras a cada envio — e a proibição acima diz que ela nunca fica em texto puro. A conciliação é cifrá-la com uma chave **que não está armazenada em lugar nenhum**: ela é derivada do PIN do usuário a cada destravamento.

| Parâmetro | Valor | Por quê |
|---|---|---|
| KDF | PBKDF2-HMAC-SHA256, 600.000 iterações | Recomendação do OWASP; ~0,3 s por tentativa torna força bruta sobre PIN de 6 dígitos uma operação de dias |
| Cifra | AES-256-GCM | Autenticada: adulterar o cofre no `localStorage` invalida a tag em vez de devolver outra frase |
| Chave derivada | `extractable: false` | Nem com XSS a chave AES vira bytes em JavaScript |
| Salt e IV | 16 e 12 bytes aleatórios por cofre | Dois usuários com o mesmo PIN não produzem cofres comparáveis |

**Por que um PIN se a conta é passkey.** A passkey autentica *para o servidor*; ela não produz, sozinha, um segredo local do qual derivar uma chave de cifra. O cofre protege contra quem já tem o dispositivo destravado — extensão maliciosa, aba aberta, XSS. A extensão PRF do WebAuthn resolveria isso de forma mais elegante e é a evolução natural do módulo; não é usada hoje porque o suporte é desigual entre navegadores e um cofre que só abre em metade dos dispositivos tranca o usuário fora do próprio dinheiro. O formato guarda o campo `kdf` para permitir a migração sem quebrar cofres existentes.

**O que o cofre não resolve, e está escrito no módulo:** enquanto o cofre está aberto, a frase está em memória — assinar exige a chave. A janela é reduzida (a frase existe só dentro de `executeSend`, o signer é liberado no `finally`, e ela nunca vira estado de React), não eliminada. Dizer o contrário seria falso.

**Enforcement:** teste que serializa o cofre e falha se qualquer uma das 12 palavras aparecer no resultado.

### 2.2 Ordem do envio

A sequência abaixo é código (`packages/wallet/src/flow.ts`), não convenção de quem escreve a tela:

```
destravar → sincronizar → montar → validar → assinar → finalizar → conferir → transmitir → descartar a chave
```

Cada inversão tem consequência concreta: validar depois de assinar deixa no dispositivo uma transação inválida já assinada; transmitir antes de conferir a finalização produz rejeição críptica e o usuário não sabe se o dinheiro foi; sincronizar depois de montar faz a carteira reportar saldo insuficiente quando o dinheiro está lá.

O guard de saídas é chamado de dentro de `buildTransfer`/`buildWithdrawal` — não há caminho de construção que o contorne. Testes injetam falha de rede e verificam que as etapas `signing` e `broadcasting` nunca foram alcançadas.

**A transmissão é o ponto sem volta**, e é feita pelo dispositivo direto ao Esplora, sem passar pelo nosso servidor. O servidor é avisado depois, pelo txid; falhar nesse aviso não desfaz nada, e a interface diz isso ao usuário em vez de fingir que o envio não aconteceu.

---

## 3. Autenticação

| Camada | Implementação | Estado |
|---|---|---|
| **Primária** | **Passkeys / WebAuthn** — sem senha, resistente a phishing, sem segredo compartilhado no servidor | ✅ implementado |
| Sessão | Token opaco de alta entropia; **apenas o hash** no banco; cookie `HttpOnly`, `Secure`, `SameSite=Strict`; expiração absoluta e por inatividade | ✅ implementado |
| Reautenticação | Obrigatória para: envio acima do limite de política, novo destinatário, dispositivo não reconhecido, contato alterado recentemente | ✅ implementado |
| 2FA | Desnecessário: a passkey já é posse + biometria/PIN. Não há senha a complementar | — por design |
| Fallback por senha | **Não existe.** Ver "por que não há senha" abaixo | — por design |

### 3.1 Passkey como único fator

Não há senha, e isso é decisão, não lacuna. Uma senha seria o elo fraco: reusada, phishável, e obrigaria a guardar um verificador no servidor — mais um segredo a vazar. A passkey não tem nada disso. O que o banco guarda de cada credencial é **chave pública, ID e contador** — material que, vazado inteiro, não autentica ninguém.

A consequência é dura e está assumida: **perder todos os autenticadores é perder o acesso à conta.** Não existe "esqueci minha senha", porque não existe senha e porque não temos e-mail nem telefone do usuário para recuperar por lá (§18 dos requisitos — sem KYC próprio, sem base de identidade). A mitigação é o próprio ecossistema de passkeys: elas sincronizam entre dispositivos do usuário (iCloud Keychain, Google Password Manager, gerenciadores de terceiros), e a UI incentiva cadastrar mais de uma. A API recusa apagar a última credencial (`last_credential`, HTTP 409) justamente para não deixar o usuário se trancar do lado de fora.

O fundo é separado desse risco: a carteira é não-custodial, e o backup de 12 palavras recupera **o dinheiro** independentemente da conta. Perder a passkey custa o histórico e a conta, não os fundos.

### 3.2 O que protege o quê

| Propriedade | Como é obtida | Onde falha se mal configurado |
|---|---|---|
| Antiphishing | O navegador só oferece a credencial ao **RP ID** que a registrou, e o `origin` assinado no `clientData` é verificado no servidor | `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` errados aceitam assinatura de qualquer lugar — o gate de config recusa `http://` em produção |
| Anti-replay | Challenge aleatório persistido, de **uso único** e com expiração curta. É consumido dentro de uma transação Firestore **antes** da verificação — inclusive quando a verificação falha | Challenge reutilizável transforma uma assinatura capturada em login |
| Anticlonagem | O contador de assinaturas do autenticador tem de avançar. Regressão → `counter_regression` (HTTP 403) e registro em `auditLogs` | — |
| Pseudonimato | O `userName` do WebAuthn é o ID interno da conta, não e-mail. Nenhum dado pessoal chega ao autenticador nem ao banco | — |

Autenticadores que não implementam contador (mantêm zero) são aceitos: pela especificação, contador estático significa "não suportado", não "clonado". A detecção só age quando o valor **retrocede**.

### 3.3 Superfície

| Rota | Para quê |
|---|---|
| `POST /auth/register/start` · `/finish` | Cria conta e primeira passkey |
| `POST /auth/login/start` · `/finish` | Login (discoverable credential — sem identificador digitado) |
| `POST /auth/reauth/start` · `/finish` | Confirma identidade numa sessão já aberta; carimba `reauthAt` **naquela sessão**, nunca em outra |
| `GET` · `DELETE /auth/credentials` | Lista e revoga passkeys; a última não pode ser removida |

Tentativas de login malsucedidas alimentam o rate limiting no modo `failures`.

### Rate limiting e força bruta

Dois modos, porque são dois problemas diferentes:

| Modo | Conta | Para quê |
|---|---|---|
| `failures` | só tentativas malsucedidas | força bruta — quem acertou a senha não é punido por ter errado antes |
| `all` | toda tentativa | throttling de operação — impede cem cobranças por minuto e estourar o limite do próprio operador |

| Endpoint | Limite | Modo |
|---|---|---|
| Login | 5 / 15 min | `failures` |
| Recovery | 3 / hora | `failures` |
| Criação de cobrança | 10 / min | `all` |
| Preparo de envio | 10 / min | `all` |
| Confirmação de transmissão | 20 / min | `all` |
| Consulta de chave Pix | 20 / min | `all` |
| Registro de carteira | 5 / hora | `all` |

A tentativa é registrada **antes** de a operação executar: registrar só no sucesso permitiria disparar várias operações lentas em paralelo antes de a primeira contar.

Bloqueio por conta **e** por IP — bloquear só por IP não protege contra botnet; bloquear só por conta permite DoS de conta alheia.

---

## 4. Aplicação web

| Vetor | Defesa |
|---|---|
| **Injeção em query** | Não há SQL. Entrada de usuário nunca vira caminho de documento sem passar por `idComponent()`, que sanitiza e evita colisão de chave |
| **XSS** | CSP restritiva sem `unsafe-inline`/`unsafe-eval`; escaping por padrão do framework; `dangerouslySetInnerHTML` proibido por lint |
| **CSRF** | `SameSite=Strict` + token anti-CSRF em toda mutação; validação de `Origin`; CORS com lista fixa de origens e nunca `*` |
| **Clickjacking** | `frame-ancestors 'none'` |
| **Vazamento por contexto de navegação** | `Cross-Origin-Opener-Policy: same-origin` — uma aba que segura a seed em memória não deve compartilhar contexto com página aberta por nós ou que nos abra |
| Transporte | HTTPS obrigatório, HSTS com preload |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restritiva |
| Dependências | Lockfile; auditoria automatizada no CI; `lwk_wasm` com integridade verificada |

**Nota específica de carteira web:** um XSS numa carteira non-custodial pode roubar a seed em memória. Por isso a CSP não é "boa prática" aqui — é controle de custódia. Qualquer PR que relaxe a CSP exige aprovação explícita e justificativa registrada.

**A CSP é servida por `middleware.ts`, com nonce por requisição — não como cabeçalho estático.**

Isto não é preferência de arquitetura; é a única forma que funciona sem abrir mão da proteção. O Next injeta scripts inline para hidratar o React. Uma CSP estática sem `'unsafe-inline'` os bloqueia e o aplicativo chega ao usuário **sem um único botão funcionando** — build passa, testes passam, e a página está morta. Com `'unsafe-inline'`, a CSP devolveria ao atacante exatamente a capacidade que existe para tirar.

O nonce resolve os dois: gerado por requisição, aplicado pelo Next aos próprios scripts, e inacessível a script injetado por XSS. O custo é render dinâmico (`export const dynamic = 'force-dynamic'` no layout raiz), que para este aplicativo é zero — todas as telas são `'use client'` e o HTML nunca teve conteúdo a cachear.

> Este bug foi encontrado por `npm run smoke:web`, que abre o app num Chromium de verdade. Nenhum teste de unidade e nenhum build o pegaria: a CSP só é aplicada por um navegador.

**O único afrouxamento aprovado, e sua justificativa:** `script-src` inclui `'wasm-unsafe-eval'`. Compilar WebAssembly é bloqueado por `script-src 'self'` sozinho, e sem WebAssembly não há LWK — logo, não há assinatura no dispositivo, e a única alternativa seria assinar no servidor, que é exatamente o que a arquitetura recusa. O token permite compilar wasm e **não** reabilita `eval` nem `new Function` para JavaScript; `'unsafe-eval'` continua fora.

`connect-src` também lista o Esplora, porque é assim que o dispositivo lê UTXOs e transmite a transação. Sem ele, a carteira dependeria do nosso servidor para alcançar a rede — e deixaria de ser non-custodial em qualquer sentido prático.

`style-src` ainda aceita `'unsafe-inline'`: o Next injeta estilos críticos inline e não os assina com o nonce. CSS injetado não executa código; o risco é exfiltração por seletor, de outra ordem de grandeza que a de script arbitrário. Fica registrado como dívida, não como decisão final.

---

## 4.1 Leitura de QR

A câmera é lida com a `BarcodeDetector` do próprio navegador, sem biblioteca de terceiros. Não é economia de bytes: uma dependência de decodificação roda sobre os quadros da câmera, na mesma origem que segura a seed durante a assinatura. Cada dependência nesse caminho é código externo com acesso à imagem e ao `window` — a CSP proíbe script externo justamente por isso, e importar um decodificador via bundle contornaria a proibição sem removê-la do modelo de ameaças.

O preço é que Safari e Firefox de desktop não têm a API. Onde ela falta, o botão não aparece e o campo de colar continua ali. Uma câmera que não abre é bem menos grave do que um endereço lido errado.

O texto lido **nunca** vira destino automaticamente sem classificação: `classifyScan` reconhece o que tem forma clara e devolve `unknown` para o resto, e a tela mostra o resultado para conferência. O endereço ainda passa pela validação de rede em `parseAddress` antes de virar transação.

---

## 4.2 Painel administrativo

| Regra | Como é feita valer |
|---|---|
| Ser admin é documento, não flag | Coleção `adminUsers` separada — um campo `isAdmin` em `users` seria alterável por qualquer caminho que já escreva no usuário |
| Não há rota para promover a admin | O primeiro nasce por `npm run bootstrap -- admin <userId>`, que exige acesso ao ambiente. Uma rota dessas é o alvo que um atacante com sessão procura |
| Toda ação exige motivo | `writeAuditLog` lança em `actorKind: 'admin'` sem `reason` — erro em tempo de execução, não convenção de revisão |
| `auditor` lê, `operator` age | Papéis separados: consultar não deveria custar o mesmo poder que agir |
| Nada de dado pessoal | Não por política de acesso: porque não existe. Não coletamos identidade (§18), então o painel mostra identificador opaco, saldo e estado |
| Não existe "corrigir saldo" | Ajuste é lançamento no ledger, com contrapartida e idempotência. Um botão desses seria crédito sem lastro com outro nome (§43) |
| Fechar divergência exige explicar | "Resolvido" sem nota é indistinguível de "alguém apertou o botão para a lista parar de incomodar" |

O filtro que impede segredo na trilha (`seed`, `mnemonic`, `privateKey`, `token`, `cpf`…) casa camelCase e snake_case. A primeira versão listava só `private_key` e deixava `privateKey` passar — o teste pegou.

---

## 5. Integridade das integrações

### Webhooks

Ordem obrigatória, sem exceção:

```
1. ler bytes BRUTOS do corpo (antes de qualquer parse)
2. verificar HMAC-SHA256(secret, "{timestamp}.{raw_body}") — comparação em TEMPO CONSTANTE
3. rejeitar timestamp fora da janela (anti-replay)
4. gravar evento bruto em `webhookEvents`, com `signatureOk`
5. dedupe pelo ID do documento (`providerCode__eventId`) — `create()` é a constraint
6. responder 2xx rapidamente
7. processar assíncrono na fila
8. atualizar ledger com idempotency_key
```

- Assinatura inválida → grava com `signature_ok = false`, **não processa**, alerta.
- Reserializar o JSON antes de verificar invalida a assinatura — erro clássico, coberto por teste.
- Entrega é *at-least-once* (6 tentativas em ~17 h): duplicata é esperada, não excepcional.

### Nunca confiar em resposta única

Uma transação **jamais** vai para `COMPLETED` por causa de um HTTP 200 ou de um webhook isolado. Exigimos:

- **Pix:** webhook validado **+** consulta ativa de status ao provider.
- **On-chain:** transação confirmada com o número de confirmações da política, valor **e asset ID** validados byte a byte.

### Segredos

Em vault/variáveis de ambiente com rotação — nunca no repositório, nunca em `providers.config` (que guarda só configuração não-secreta). Chaves de produção (`sk_live_`) exigem a flag de liberação descrita em REGULATORY_ARCHITECTURE.md §7.

---

## 6. Integridade financeira

### Gasto duplo e concorrência

Cenário da seção 39 dos requisitos — R$ 100 de saldo, dois navegadores, R$ 100 em cada:

```
runTransaction:
  ── LEITURA ──────────────────────────────────────────
  ler ledgerTransactions/{chave}   → existe? devolve deduplicated, fim
  ler as ledgerAccounts envolvidas

  ── VALIDAÇÃO (em memória) ───────────────────────────
  soma zero por ativo? saldo do usuário ficaria negativo? cabe em int64?

  ── ESCRITA ──────────────────────────────────────────
  create ledgerTransactions/{chave}   ← constraint de idempotência
  create ledgerEntries/{chave}__{i}
  update balance de cada conta
```

Não há `FOR UPDATE`: a concorrência do Firestore é **otimista**. Se o saldo lido mudar antes do commit, a transação é reexecutada — e a segunda tentativa relê o saldo já debitado e falha por saldo insuficiente. O efeito para o gasto duplo é o mesmo; o mecanismo é diferente, e a diferença importa para quem for depurar.

⚠️ **Sem trigger de defesa em profundidade.** No PostgreSQL, um trigger rejeitava o commit se o saldo ficasse negativo mesmo que a aplicação errasse. No Firestore isso não existe: a checagem vive em `packages/ledger/src/posting.ts` e a conciliação é o que detecta violação. Ver DATABASE.md §2.

**Ordem obrigatória:** debitar no ledger **antes** de enviar. Falha no envio gera lançamento de estorno (`pending_out → available`) — nunca "esquecer" o débito. O caso "falhou depois de debitar e antes de enviar" é teste obrigatório (seção 38).

### Idempotência

Toda operação financeira carrega uma chave de idempotência que **é o ID do documento** — `create()` falha com `ALREADY_EXISTS`, que é a mesma força de um `UNIQUE`:

| Documento | Impede |
|---|---|
| `txIdempotencyIndex/{userId}__{key}` | Transação duplicada por duplo clique/retry |
| `ledgerTransactions/{key}` | Lançamento duplicado |
| `webhookEvents/{provider}__{eventId}` | Webhook duplicado |
| `e2eIndex/{e2eId}` | O mesmo Pix creditar duas vezes |
| `liquidTransactions/{txid}__{vout}__{dir}` | O mesmo UTXO creditar duas vezes |

Idempotência garantida pelo **banco**, não por verificação em código — código tem race condition, `create()` não.

### Validação de asset e endereço

Antes de qualquer envio, em três camadas: seleção de UTXO filtrando por asset ID; validação da transação montada antes de assinar; validação do endereço de destino (rejeitar endereço de rede incompatível). Impede o cenário "enviei pela rede errada e perdi".

**Validação crítica do saque DePix→Pix:** a saída de taxa precisa ser **explícita/não-blindada** e no asset DePix. Blindada, o provider documenta que a operação falha e **pode perder os fundos**. Validação pré-broadcast obrigatória: se a saída de taxa estiver blindada ou com asset errado, **abortamos sem transmitir**.

### Nunca automatizar sobre inconsistência

Divergência de conciliação, transação travada ou valor inesperado → `MANUAL_REVIEW` e alerta. **Nunca** reenviar, recreditar ou compensar automaticamente (seção 43 dos requisitos).

---

## 7. Painel administrativo

RBAC com quatro papéis: `viewer`, `operator`, `compliance`, `superadmin`. 2FA obrigatório para todos.

**Admin não altera saldo.** Não existe endpoint, comando ou caminho de UI para "definir saldo". Toda correção é um lançamento na conta `system_adjustment` via `ledger_transactions`, exigindo motivo, operador, horário e referência — registrado em `audit_logs` e visível na conciliação.

⚠️ **Mudou com o Firestore.** No PostgreSQL, a role da aplicação não tinha permissão de `UPDATE`/`DELETE` em `ledger_entries` — era permissão negada pelo banco. O Firestore não oferece equivalente: regras de segurança não se aplicam ao Admin SDK (verificado contra o emulador). A garantia passou a ser: nenhuma função de update/delete de lançamento existe em `packages/ledger`, e a conciliação recomputa os saldos a partir dos lançamentos para detectar qualquer escrita feita por fora. Ver DATABASE.md §2.

Toda ação administrativa gera `audit_logs` com motivo obrigatório. Ações sensíveis (bloquear saque, alterar limite, desativar provider) exigem reautenticação.

---

## 8. Limites e antifraude

| Controle | Regra |
|---|---|
| Limite por transação / diário / mensal | Configurável por usuário (`limits`), nunca acima do limite do provider |
| Primeiro saque | Limite reduzido |
| Novo dispositivo | Período de espera (padrão 24 h) antes de saques de valor alto |
| Novo destinatário | Confirmação reforçada |
| **Contato alterado recentemente** | Contato com `updated_at` recente usado em operação de valor alto exige reautenticação — defesa contra troca de endereço por atacante com sessão ativa |
| Cooldown de segurança | Alteração de senha/2FA/passkey bloqueia saques por período definido |
| Alertas | Notificação imediata (login novo, dispositivo novo, alteração de segurança, transação) — canal independente da sessão |

---

## 9. Logs e observabilidade

### Redaction obrigatória — nunca aparecem em log, APM, analytics ou mensagem de erro

```
seed · mnemônico · chave privada · master blinding key privada
senha · token de sessão · segredo de 2FA · webhook secret · sk_live_/sk_test_
CPF/CNPJ (taxNumber) · chave Pix completa · saldo associado a identidade
```

**Enforcement:** filtro de redaction na camada de logging por lista de chaves conhecidas **e** por padrão (regex de mnemônico BIP39, formato de CPF, prefixos `sk_live_`/`sk_test_`). Teste de CI verifica que campos sensíveis conhecidos não vazam.

### O que registramos

Logging estruturado com `request_id`/`X-Request-Id` correlacionado ao provider; máquina de estados completa em `transaction_events`; métricas (latência de provider, fila, confirmações pendentes, divergências de conciliação); health checks (banco, fila, Esplora, provider); alertas para falha de assinatura de webhook, divergência de conciliação, transação travada, taxa de erro do provider.

### Telemetria (seção 18.9)

Analytics mínimo e anonimizado. **Nunca** enviamos saldo, valor de transação associado a identidade, chave Pix, endereço completo ou qualquer segredo. Sem ferramenta de perfil comercial do usuário.

---

## 10. Recovery non-custodial

O problema difícil da autocustódia: perder a seed é perder o dinheiro, e não podemos recuperá-la — por design.

| Método | Status | Observação |
|---|---|---|
| Seed phrase (BIP39) | Base | Exibida uma vez, com verificação de que o usuário anotou, **antes do primeiro depósito** |
| Backup criptografado no dispositivo | Planejado | Cifrado com chave derivada de senha do usuário |
| Backup em nuvem do usuário (iCloud/Drive) | Planejado | **Cifrado no dispositivo antes de sair.** Nós não temos a chave e não hospedamos |
| Social recovery | Avaliar | Complexidade alta |
| MPC | Avaliar | Evolução possível (ARCHITECTURE.md §7) |

**Nunca** enviamos seed ao servidor, cifrada ou não. Backup em nuvem é entre o usuário e o provedor de nuvem **dele**.

**Consequência de UX que precisa ser respeitada:** o fluxo de backup é obrigatório antes do primeiro depósito. Não é uma tela pulável. Um usuário que recebe R$ 500 sem ter feito backup é uma perda de dinheiro esperando acontecer, e a responsabilidade de evitá-la é do design, não do usuário.

---

## 11. Testes de segurança obrigatórios (seção 38)

- [ ] Webhook com assinatura inválida é rejeitado e não processa
- [ ] Webhook duplicado (mesmo `X-DePix-Event-Id`) não credita duas vezes
- [ ] Webhook fora de ordem não regride estado
- [ ] Corpo reserializado antes da verificação → assinatura falha (regressão)
- [ ] Dois saques simultâneos com saldo para um só: exatamente um sucede
- [ ] Falha após débito e antes do envio → estorno correto no ledger
- [ ] Saldo insuficiente com taxa incluída é rejeitado
- [ ] Asset ID errado não credita
- [ ] Saída de taxa blindada no saque → **aborta antes de transmitir**
- [ ] Endereço de rede incompatível é rejeitado
- [ ] Provider indisponível/timeout não deixa transação em estado ambíguo
- [ ] Transação Liquid não confirmada não vira `COMPLETED`
- [ ] Reorg reverte crédito não finalizado
- [ ] Pix rejeitado gera refund para `refundAddress`
- [ ] Divergência de conciliação bloqueia e **não** dispara envio automático
- [ ] Campo sensível não aparece em log (seed, CPF, chave Pix, `sk_live_`)
- [ ] Nenhum campo de seed/chave privada existe nos documentos gravados
- [ ] Quantia acima de 2^53 faz round-trip exato (sem perda de precisão)
- [ ] Nenhum bigint atravessa a fronteira HTTP (quebraria a serialização)
- [ ] Conciliação DETECTA saldo adulterado por fora do ledger
- [ ] Admin não consegue alterar saldo por nenhum caminho
