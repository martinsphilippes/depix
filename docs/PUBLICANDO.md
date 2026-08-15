# Publicar na internet

Vercel hospeda a interface **e** a API (mesma origem). Firebase hospeda o
banco. Três etapas, ~10 minutos.

> ⚠️ **A chave da conta de serviço dá acesso total ao banco.** Ela não vai
> para o repositório, não entra em log e não passa por chat — o lugar dela é o
> painel de variáveis da Vercel e um gerenciador de senhas. Se ela vazar em
> algum momento, revogue em **Configurações → Contas de serviço → Gerenciar
> chaves** e gere outra; o sistema volta a funcionar assim que a nova estiver
> no painel.

> **Continua sem mover dinheiro real.** O provider padrão é sandbox e a
> carteira opera em testnet. Ligar fundos reais exige `ENABLE_REAL_FUNDS=yes`
> com `APP_ENV=production`, e a aplicação recusa subir sem os pré-requisitos
> de REGULATORY_ARCHITECTURE.md §5.

---

## 1. Firebase — o banco

1. Em <https://console.firebase.google.com>, **Adicionar projeto**. Anote o
   **ID do projeto** (não o nome — o ID, tipo `carteira-depix-a1b2c`).
2. **Criar banco de dados** → Firestore → modo **produção** → região
   `southamerica-east1` (São Paulo).
3. **Configurações do projeto → Contas de serviço → Gerar nova chave
   privada.** Baixa um `.json`. Guarde: é a credencial que dá acesso total ao
   banco.

> **O passo 2 não é opcional e não dá para pular.** Ter o projeto e a chave
> não cria o banco: enquanto ele não existir, toda chamada responde
> `Cloud Firestore API has not been used in project`. E a conta de serviço do
> Firebase **não tem permissão** para criar o banco nem para habilitar a API —
> é restrição do Google, não do projeto. Esse clique é seu.

Depois, um comando publica índices e regras e popula os dados de referência:

```bash
export FIREBASE_PROJECT_ID=<o-id-do-projeto>
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/para/a-chave.json
npm run firebase:preparar
```

Idempotente: repetir não estraga nada. Se o banco ainda não existir, ele diz
isso com o link direto do console em vez de falhar com erro de API.

> Os índices **não** são opcionais. Sem eles, as consultas de extrato,
> contatos e conciliação falham com `FAILED_PRECONDITION` — erro que só
> aparece na primeira vez que alguém abre aquela tela.

---

## 2. Vercel — interface e API

1. <https://vercel.com/new> → importe **martinsphilippes/depix**.
2. Em **Root Directory**, escolha **`apps/web`**.
   O resto é detectado sozinho: framework Next.js, e a instalação roda na raiz
   por causa dos workspaces do npm.
3. Antes de clicar em Deploy, abra **Environment Variables** e cole:

**São cinco variáveis. Só isso.**

| Variável | Valor |
|---|---|
| `FIREBASE_PROJECT_ID` | o ID do passo 1 |
| `FIREBASE_SERVICE_ACCOUNT` | o **conteúdo inteiro** do `.json` baixado |
| `IP_HASH_SALT` | qualquer valor aleatório longo |
| `ENCRYPTION_KEY` | gere com o comando abaixo |
| `CRON_SECRET` | qualquer valor aleatório longo |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

4. **Deploy.**

### O domínio do WebAuthn é automático

A passkey precisa saber a qual domínio ela pertence — é isso que impede um
site clonado de reaproveitá-la. Antes, isso era um problema de ovo e galinha:
a Vercel só entrega o domínio **depois** do primeiro deploy, então não havia o
que preencher antes dele.

A aplicação agora deduz o domínio de `VERCEL_PROJECT_PRODUCTION_URL`, que a
Vercel define sozinha. Não há o que configurar.

**Domínio próprio?** Aí sim defina `WEBAUTHN_RP_ID` (o domínio, sem `https://`)
e `WEBAUTHN_ORIGIN` (a URL completa). O valor explícito tem precedência.

> **Passkey não funciona nas URLs de preview.** Cada deploy de preview tem um
> domínio diferente (`carteira-depix-a1b2c3.vercel.app`), e a credencial está
> amarrada ao domínio de produção. Não é defeito: é a proteção antiphishing
> fazendo o trabalho dela. Nas previews, use e-mail e senha.

### Depois do primeiro deploy

Para acessar o painel administrativo:

```bash
npm run bootstrap -- admin <userId> operator
```

---

## 3. Conferir

```
https://SEU-DOMINIO/api/health
```

Deve responder `{"status":"ok","checks":{"firestore":"ok"}}`.

| Resposta | O que significa |
|---|---|
| `server_misconfigured` com o nome de uma variável | falta essa variável no painel da Vercel |
| `Não foi possível determinar o domínio do WebAuthn` | está rodando fora da Vercel; defina `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGIN` |
| `"firestore":"fail"` | credencial inválida, ou o Firestore não foi criado no console |
| `invalid_service_account` | o JSON foi colado incompleto ou com aspas sobrando |
| `status: ok` mas a primeira operação falha | faltou o `npm run bootstrap` |

Depois: abra o domínio, crie conta com e-mail e senha, crie a carteira. No
Android, o convite de instalação aparece na tela inicial; no iPhone,
Compartilhar → Adicionar à Tela de Início.

---

## O que muda ao publicar

**A API vira função serverless**, montada em `/api/*` pelo próprio Next. Mesma
origem que a interface — o que elimina CORS, deixa o cookie `SameSite=Strict`
valer sem exceção, e faz o RP ID do WebAuthn ser o próprio domínio.

**O worker vira cron**, a cada 10 minutos, porque a Vercel não hospeda
processo contínuo. A diferença é de **latência**, não de correção: uma
transação demora até um ciclo a mais para ser confirmada. O que não muda é que
só o worker conclui transação, e só depois de ver confirmação real na cadeia.

Se a latência incomodar, o worker contínuo (`npm run worker`) roda em qualquer
lugar que aceite processo longo — Railway, Fly.io, uma VM — apontando para o
mesmo Firestore. Os dois modos usam o mesmo código e podem coexistir: a fila
usa lease, então dois workers não processam o mesmo job.

**O custo:** dentro do plano gratuito da Vercel e do Firestore para uso de
demonstração. O cron a cada 10 minutos são ~4.300 execuções/mês, e cada uma faz
uma varredura de conciliação — se a cota apertar, aumente o intervalo em
`apps/web/vercel.json`.
