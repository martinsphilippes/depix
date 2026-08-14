/**
 * Segundo ato do passeio: com saldo, e com um envio de verdade.
 *
 * Cria a conta, cria a carteira, credita o ledger (papel do worker num Pix
 * confirmado — aqui é feito direto, porque não há operador de Pix sandbox
 * pagando de verdade), e então percorre o envio até a política de segurança
 * pedir a passkey.
 */

import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.WEB_URL ?? 'http://localhost:3996';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots2';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

let n = 0;
const shot = async (nome) => {
  n += 1;
  const arquivo = `${OUT}/${String(n).padStart(2, '0')}-${nome}.png`;
  await page.screenshot({ path: arquivo, fullPage: true });
  console.log('  →', arquivo);
};

// --- Conta e carteira -------------------------------------------------------
console.log('== criando conta e carteira');
await page.goto(`${BASE}/entrar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Criar conta/ }).click();
await page.waitForURL(/\/carteira/, { timeout: 20_000 });

await page.getByRole('button', { name: /Criar carteira nova/ }).click();
await page.waitForSelector('ol li', { timeout: 60_000 });
const palavras = await page.$$eval('ol li', (els) => els.map((e) => e.textContent.trim()));

await page.getByRole('button', { name: /Anotei minha frase/ }).click();
await page.waitForSelector('input[id^="p"]', { timeout: 10_000 });
for (const campo of await page.$$('input[id^="p"]')) {
  const id = await campo.getAttribute('id');
  await campo.fill(palavras[Number(id.slice(1))]);
}
await page.getByRole('button', { name: /^Confirmar$/ }).click();
await page.waitForSelector('input#pin', { timeout: 10_000 });
await page.fill('#pin', '271828');
await page.fill('#pin2', '271828');
await page.getByRole('button', { name: /Concluir/ }).click();
await page.waitForTimeout(4000);

// --- Crédito no ledger ------------------------------------------------------
// É o que o worker faz quando um Pix é confirmado. Aqui vai direto, porque
// não há operador sandbox pagando de verdade.
console.log('== creditando R$ 1.200,00 no ledger');
const saida = execFileSync(
  'node',
  ['--experimental-strip-types', 'scripts/creditar-demo.ts'],
  { cwd: process.cwd(), encoding: 'utf8', env: process.env },
);
console.log('  ', saida.trim().split('\n').pop());

// --- Dashboard com saldo ----------------------------------------------------
console.log('== dashboard com saldo');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await shot('inicio-com-saldo');

// --- Envio abaixo do limite de confirmação ---------------------------------
// R$ 80,00 e não mais: o limite padrão do primeiro envio é R$ 100 (§ limites
// conservadores em `DEFAULT_LIMITS`). Passar disso mostraria a recusa, que já
// tem tela própria — aqui o que interessa é a revisão com a taxa.
console.log('== primeiro envio, R$ 80,00 — revisão com taxa');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Enviar para outra carteira/ }).click();
await page.fill(
  '#dest',
  'tlq1qq2xvpcvfup5j8zscjq05u2wxxjcyewk7979f3mmz5l7uw5pqmx6xf5xy50hsn6vhkm5euwt72x878eq6zxx2z58hd7zrsg9qn',
);
await page.fill('#valor', '80,00');
await page.getByRole('button', { name: /Revisar envio/ }).click();
await page.waitForTimeout(3000);
await shot('envio-revisao');

// --- Envio acima do limite: a política pede passkey ------------------------
console.log('== envio de R$ 800,00 — acima do limite, política dispara');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Enviar para outra carteira/ }).click();
await page.fill(
  '#dest',
  'tlq1qqfn5cmzz4pf2p6y5xn3s3vamsjc4c2r0zqzs9lvv2xtxr3cvxvhxsftjqnvxu5cjc4unhzp4vlxxtd4qkzz0zsy4rvw7c2r0',
);
await page.fill('#valor', '800,00');
await page.getByRole('button', { name: /Revisar envio/ }).click();
await page.waitForTimeout(3000);
await shot('envio-pede-passkey');

// --- Extrato ----------------------------------------------------------------
console.log('== extrato com movimentações');
await page.goto(`${BASE}/historico`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await shot('extrato-com-movimentacoes');

// --- Painel administrativo --------------------------------------------------
console.log('== concedendo acesso de operador e abrindo o painel');
execFileSync('node', ['--experimental-strip-types', 'scripts/promover-demo.ts'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
});
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await shot('painel-conciliacao');

await page.getByRole('button', { name: /Rodar conciliação agora/ }).click();
await page.waitForTimeout(6000);
await shot('painel-apos-conciliar');

await page.goto(`${BASE}/ajustes`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await shot('ajustes-com-painel');

await browser.close();
console.log('\npronto:', n, 'telas');
