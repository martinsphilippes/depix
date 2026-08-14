/**
 * Passeio guiado pelo sistema, com capturas de tela.
 *
 * Percorre o caminho real do usuário — criar conta por passkey, criar
 * carteira com backup conferido, receber, enviar, contatos, avisos, painel —
 * num Chromium de verdade, e salva uma imagem de cada passo.
 *
 * A passkey funciona porque o Chrome expõe um **autenticador virtual** pelo
 * CDP. Não é mock nosso: é o navegador implementando WebAuthn de verdade
 * contra uma chave de software. O servidor verifica a assinatura pelo mesmo
 * caminho de produção — se a origem ou o desafio estivessem errados, isto
 * falharia aqui.
 */

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.WEB_URL ?? 'http://localhost:3996';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

// --- Autenticador virtual ---------------------------------------------------
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
console.log('autenticador virtual:', authenticatorId);

let n = 0;
const shot = async (nome) => {
  n += 1;
  const arquivo = `${OUT}/${String(n).padStart(2, '0')}-${nome}.png`;
  await page.screenshot({ path: arquivo, fullPage: true });
  console.log('  →', arquivo);
};

const passo = (t) => console.log(`\n== ${t}`);

// --- 1. Entrada -------------------------------------------------------------
passo('tela inicial sem sessão');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shot('inicio-sem-sessao');

passo('tela de entrada');
await page.goto(`${BASE}/entrar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot('entrar');

passo('criar conta por passkey');
await page.getByRole('button', { name: /Criar conta/ }).click();
await page.waitForURL(/\/carteira/, { timeout: 20_000 });
await page.waitForTimeout(1000);
await shot('carteira-escolha');

// --- 2. Carteira ------------------------------------------------------------
passo('gerar as 12 palavras');
await page.getByRole('button', { name: /Criar carteira nova/ }).click();
await page.waitForSelector('ol li', { timeout: 60_000 });
await page.waitForTimeout(500);
await shot('frase-de-recuperacao');

const palavras = await page.$$eval('ol li', (els) => els.map((e) => e.textContent.trim()));
console.log('  palavras:', palavras.length);

passo('conferência do backup');
await page.getByRole('button', { name: /Anotei minha frase/ }).click();
await page.waitForSelector('input#p0, input[id^="p"]', { timeout: 10_000 });
await page.waitForTimeout(300);
await shot('conferir-backup');

// Preenche as palavras sorteadas. Os rótulos dizem "Palavra número N".
const campos = await page.$$('input[id^="p"]');
for (const campo of campos) {
  const id = await campo.getAttribute('id');
  const indice = Number(id.slice(1));
  await campo.fill(palavras[indice]);
}
await page.getByRole('button', { name: /^Confirmar$/ }).click();
await page.waitForSelector('input#pin', { timeout: 10_000 });

passo('definir PIN do cofre');
await page.fill('#pin', '271828');
await page.fill('#pin2', '271828');
await page.waitForTimeout(300);
await shot('definir-pin');

await page.getByRole('button', { name: /Concluir/ }).click();
await page.waitForTimeout(4000);
await shot('carteira-pronta');

// --- 3. Saldo (creditado por fora, para a demonstração) ---------------------
passo('dashboard sem saldo');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await shot('inicio-sem-saldo');

// --- 4. Receber -------------------------------------------------------------
passo('receber de outra carteira (endereço + QR)');
await page.goto(`${BASE}/receber`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Receber de outra carteira/ }).click();
await page.waitForSelector('img[alt*="QR"]', { timeout: 30_000 });
await page.waitForTimeout(500);
await shot('receber-endereco-qr');

passo('receber por Pix (cobrança + QR)');
await page.goto(`${BASE}/receber`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Receber por Pix/ }).click();
await page.fill('#amount', '250,00');
await page.getByRole('button', { name: /Gerar cobrança/ }).click();
await page.waitForSelector('.copy-box', { timeout: 30_000 });
await page.waitForTimeout(500);
await shot('receber-pix-qr');

// --- 5. Contatos ------------------------------------------------------------
passo('contatos');
await page.goto(`${BASE}/contatos`, { waitUntil: 'networkidle' });
await page.fill('#label', 'Maria');
await page.fill(
  '#destino',
  'tlq1qq2xvpcvfup5j8zscjq05u2wxxjcyewk7979f3mmz5l7uw5pqmx6xf5xy50hsn6vhkm5euwt72x878eq6zxx2z58hd7zrsg9qn',
);
await page.getByRole('button', { name: /Adicionar contato/ }).click();
await page.waitForTimeout(1500);
await shot('contatos');

passo('trocar endereço exige passkey');
await page.getByRole('button', { name: /Alterar endereço/ }).first().click();
await page.waitForTimeout(600);
await shot('contato-troca-endereco');

// --- 6. Enviar --------------------------------------------------------------
passo('enviar — escolha');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot('enviar-escolha');

passo('enviar Pix — honesto sobre o que falta');
await page.getByRole('button', { name: /Enviar Pix/ }).click();
await page.fill('#pixKey', 'maria@email.com');
await page.getByRole('button', { name: /Continuar/ }).click();
await page.waitForTimeout(1500);
await shot('enviar-pix-pendente');

passo('enviar para carteira — formulário com agenda');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Enviar para outra carteira/ }).click();
await page.waitForTimeout(800);
await shot('enviar-carteira-form');

passo('enviar sem saldo — o erro que o ledger produz');
await page.fill(
  '#dest',
  'tlq1qq2xvpcvfup5j8zscjq05u2wxxjcyewk7979f3mmz5l7uw5pqmx6xf5xy50hsn6vhkm5euwt72x878eq6zxx2z58hd7zrsg9qn',
);
await page.fill('#valor', '50,00');
await page.getByRole('button', { name: /Revisar envio/ }).click();
await page.waitForTimeout(2000);
await shot('enviar-sem-saldo');

// --- 7. Avisos e ajustes ----------------------------------------------------
passo('avisos');
await page.goto(`${BASE}/avisos`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shot('avisos');

passo('ajustes');
await page.goto(`${BASE}/ajustes`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await shot('ajustes');

passo('extrato');
await page.goto(`${BASE}/historico`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await shot('extrato');

// Guarda o cofre para o segundo ato (creditar saldo e enviar de verdade).
const vault = await page.evaluate(() => localStorage.getItem('depix.vault.v2'));
const cookies = await context.cookies();
console.log('\nCOFRE_FINGERPRINT=' + JSON.parse(vault).fingerprint);
console.log('SESSAO=' + (cookies.find((c) => c.name === 'session')?.value ?? ''));

await browser.close();
console.log('\npronto:', n, 'telas');
