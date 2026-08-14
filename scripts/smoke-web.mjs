/**
 * Teste de fumaça do navegador.
 *
 * O build passar não prova que o LWK carrega: WebAssembly no browser passa
 * por CSP, por `asyncWebAssembly` do webpack e pelo carregamento do `.wasm`
 * como recurso — três coisas que só falham em tempo de execução, e falham
 * silenciosamente para quem só olha o build.
 *
 * Este script abre o app num Chromium de verdade, gera uma carteira e cifra
 * um cofre. Se o wasm ou o WebCrypto não estiverem disponíveis, falha aqui —
 * e não na mão do primeiro usuário.
 */

import { chromium } from 'playwright';

const BASE = process.env.WEB_URL ?? 'http://127.0.0.1:3996';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

const erros = [];
page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') erros.push(`console: ${m.text()}`);
});

let falhou = false;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhou = true;
};

// 1. As páginas carregam.
for (const rota of ['/', '/entrar', '/carteira', '/receber', '/enviar', '/contatos', '/avisos', '/admin']) {
  const r = await page.goto(`${BASE}${rota}`, { waitUntil: 'networkidle' });
  check(`carrega ${rota}`, r?.status() === 200, `HTTP ${r?.status()}`);
}

// 2. O que mais importa: o LWK carrega e gera uma carteira DENTRO do
//    navegador, acionado pela própria interface — o caminho real do usuário.
await page.goto(`${BASE}/carteira`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Criar carteira nova/ }).click();
await page.waitForSelector('ol li', { timeout: 60_000 });

const palavras = await page.$$eval('ol li', (els) => els.map((e) => e.textContent?.trim() ?? ''));
check('LWK gera 12 palavras no navegador', palavras.length === 12, `${palavras.length} palavras`);
check(
  'as palavras têm cara de mnemônico',
  palavras.every((p) => /^[a-z]{3,}$/.test(p)),
  palavras.slice(0, 3).join(' ') + '…',
);

// 4. O cofre cifra e decifra no navegador (WebCrypto sob a CSP real).
const cofre = await page.evaluate(async () => {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', enc.encode('pin-de-teste'), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('segredo'));
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cifrado);
  return new TextDecoder().decode(claro);
});
check('WebCrypto cifra e decifra sob a CSP', cofre === 'segredo', cofre);

// 4. Nenhum erro de console. É aqui que uma violação de CSP aparece — e foi
//    assim que se descobriu que a CSP estática matava a hidratação do Next.
//
//    Falhas de conexão com a API são esperadas: este teste sobe só a
//    interface, e o objetivo dele é o que roda no navegador.
const relevantes = erros.filter(
  (e) =>
    !/ERR_CONNECTION_REFUSED|Failed to load resource.*(favicon|401|404|Not Found)/.test(e),
);
check('sem erro de console (CSP inclusive)', relevantes.length === 0, relevantes.slice(0, 2).join(' | '));

await browser.close();
process.exit(falhou ? 1 : 0);
