# Como rodar e ver funcionando

Nada aqui move dinheiro real. O gate de ambiente recusa subir em produção sem
liberação explícita, e a carteira opera em **testnet** por padrão.

## O que você precisa

- **Node 22 ou mais novo** (`node --version`)
- **Java** — só o emulador do Firestore usa, e ele não sobe sem
- Nenhum banco, nenhum Docker

## Subir tudo de uma vez

```bash
npm install
npm run demo:subir
```

Sobe emulador, dados de referência, API, worker e interface, e segura até você
apertar Ctrl-C. Abra **http://localhost:3996**.

As chaves são geradas na hora e o emulador perde tudo ao ser derrubado — é
para ver o sistema funcionando, não para guardar nada.

## Subir passo a passo

Se preferir controlar cada parte. Quatro terminais; o primeiro precisa
terminar antes do segundo.

```bash
npm install
```

**1 — emulador do Firestore** (deixe rodando)

```bash
npm run emulator
```

**2 — dados de referência** (roda uma vez, depois pode fechar)

```bash
export FIREBASE_PROJECT_ID=demo-depix-dev
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
npm run bootstrap
```

**3 — API**

```bash
export FIREBASE_PROJECT_ID=demo-depix-dev
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export IP_HASH_SALT=qualquer-coisa-aleatoria
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_ORIGIN=http://localhost:3000
export ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
npm run dev --workspace=@depix/api
```

**4 — interface**

```bash
npm run dev --workspace=@depix/web
```

Abra **http://localhost:3000**.

> Use `localhost`, não `127.0.0.1`. O WebAuthn amarra a passkey ao domínio, e
> `WEBAUTHN_RP_ID=localhost` só casa com o primeiro. Trocar o host faz o
> navegador recusar a passkey — a proteção contra phishing funcionando, ainda
> que contra você.

## O caminho a percorrer

1. **Criar conta** — um clique e a biometria/PIN do seu aparelho. Sem e-mail,
   sem senha, sem cadastro. Se o navegador perguntar por uma chave de acesso,
   é isso mesmo.
2. **Criar carteira** — as 12 palavras aparecem, e o app pede três delas de
   volta antes de deixar avançar. Depois um PIN, que cifra a frase neste
   navegador.
3. **Receber** — o endereço e o QR são gerados no seu dispositivo, a partir da
   sua chave. Nada disso vem do servidor.
4. **Enviar** — sem saldo, você vê o erro que vem do ledger. Para ver a tela de
   revisão com taxa, credite saldo:

   ```bash
   node --experimental-strip-types scripts/creditar-demo.ts
   ```

5. **Limites e política** — o primeiro envio tem teto de R$ 100, e acima de
   R$ 500 o sistema pede confirmação por passkey. Para ver o pedido sem
   esperar a sessão envelhecer:

   ```bash
   node --experimental-strip-types scripts/envelhecer-sessao-demo.ts
   ```

6. **Painel** — precisa de acesso administrativo, que não tem rota HTTP de
   propósito:

   ```bash
   npm run bootstrap -- admin <userId> operator
   ```

   O `userId` aparece no console do navegador ou no emulador
   (http://localhost:4000/firestore, coleção `users`).

## O que não funciona, e por quê

| O quê | Por quê |
|---|---|
| **Enviar Pix** | Falta o contrato de saque de um operador: endereço de depósito e de taxa por cotação. Não é código faltando, é credencial. A tela diz isso em vez de simular |
| **Receber Pix de verdade** | O provider de sandbox gera um código marcado `DO-NOT-PAY`. Ele não é pagável, e é assim de propósito |
| **Lightning** | DePix é emitido na Liquid; não há ponte documentada. O botão aparece desabilitado, com o motivo |
| **Ler QR pela câmera no Safari ou Firefox de desktop** | Usamos a API do navegador em vez de biblioteca de terceiro. Onde falta, o botão some e o campo de colar continua |

## Instalar como aplicativo

A carteira é um PWA: no Android/Chrome aparece o convite "Instalar" na tela
inicial; no iPhone, o caminho é Compartilhar → **Adicionar à Tela de Início**,
e o próprio app mostra essa instrução.

Instalado, abre sem barra de endereço, com ícone próprio e atalhos para
Receber e Enviar ao segurar o ícone.

> Em desenvolvimento pela rede local (`http://192.168.x.x:3000`), o navegador
> não instala: PWA exige HTTPS, com `localhost` como única exceção. Para testar
> a instalação de outro aparelho, use um túnel HTTPS.

**Offline, o aplicativo não mostra saldo.** Não é limitação — é decisão. Um
saldo guardado em cache pareceria o atual, e decidir um envio por um número
desatualizado é como se perde dinheiro. A tela diz que falta conexão, e lembra
que o dinheiro está na Liquid e a chave no aparelho: nossa indisponibilidade
não é a indisponibilidade dele.

## Ver sem instalar nada

```bash
npm run demo        # percorre o sistema num Chromium e salva as telas
npm run smoke:api   # sobe a API e bate nas rotas por HTTP
npm run smoke:web   # abre o app num navegador e gera uma carteira
npm run smoke:pwa   # confere manifesto, service worker e comportamento offline
```

## Enviar de verdade, na testnet

Sem dinheiro real envolvido — a testnet da Liquid tem faucet:

```bash
npm run test:testnet
```

Monta, assina e transmite uma transação de verdade, e confere que o
destinatário recebeu o valor exato.
