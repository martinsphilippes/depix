# Publicar na internet

Vercel hospeda a interface **e** a API (mesma origem). Firebase hospeda o
banco. Três etapas, ~10 minutos.

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

Publique índices e regras (do seu computador, uma vez):

```bash
npx firebase login
npx firebase use --add          # escolha o projeto criado
npx firebase deploy --only firestore
```

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

| Variável | Valor |
|---|---|
| `FIREBASE_PROJECT_ID` | o ID do passo 1 |
| `FIREBASE_SERVICE_ACCOUNT` | o **conteúdo inteiro** do `.json` baixado |
| `IP_HASH_SALT` | qualquer valor aleatório longo |
| `ENCRYPTION_KEY` | gere com o comando abaixo |
| `WEBAUTHN_RP_ID` | o domínio, **sem** `https://` — ex.: `carteira-depix.vercel.app` |
| `WEBAUTHN_ORIGIN` | a URL completa — ex.: `https://carteira-depix.vercel.app` |
| `APP_ENV` | `staging` |
| `CRON_SECRET` | qualquer valor aleatório longo |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

4. **Deploy.**

### O problema do ovo e da galinha, e como resolver

`WEBAUTHN_RP_ID` precisa do domínio, que a Vercel só dá **depois** do primeiro
deploy. Faça assim: coloque um valor provisório, publique, copie o domínio real
e refaça o deploy com os valores certos.

Errar isso não dá erro visível na página — a passkey simplesmente não é aceita,
porque é o navegador que amarra a credencial ao domínio. É a proteção
antiphishing funcionando contra você.

### Depois do primeiro deploy

Popule os dados de referência (ativos, contas de sistema, providers), do seu
computador:

```bash
export FIREBASE_PROJECT_ID=<o-id-do-projeto>
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/para/a-chave.json
export ALLOW_REAL_FIRESTORE=yes     # confirma que é intencional escrever no projeto real
npm run bootstrap
```

Sem isso, `/api/health` responde mas a primeira operação falha: não há ativo
DePix cadastrado nem contas de sistema.

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
