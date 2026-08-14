/**
 * Verificação do PWA num navegador de verdade.
 *
 * Manifesto e service worker são exatamente o tipo de coisa que "parece
 * certa" no código e falha silenciosamente no navegador — uma diretiva de CSP
 * faltando basta para o registro do service worker ser recusado sem erro
 * visível na página, e o aplicativo simplesmente deixa de ser instalável.
 *
 * Este script confere o que o navegador realmente entendeu: o manifesto
 * analisado, o service worker ativo, o cache do shell e o comportamento
 * offline — que num aplicativo financeiro é onde mora a decisão mais
 * importante do PWA.
 */

import { chromium } from 'playwright';

const BASE = process.env.WEB_URL ?? 'http://localhost:3996';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();

const erros = [];
page.on('console', (m) => {
  if (m.type() === 'error') erros.push(m.text());
});

let falhou = false;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhou = true;
};

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

// --- Manifesto --------------------------------------------------------------
const manifesto = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const r = await fetch(link.getAttribute('href'));
  return r.ok ? r.json() : null;
});

check('manifesto é servido e analisável', manifesto !== null);
if (manifesto) {
  check('display standalone', manifesto.display === 'standalone', manifesto.display);
  check('tem start_url e scope', !!manifesto.start_url && !!manifesto.scope);
  check('tem id fixo', !!manifesto.id, manifesto.id);

  const tamanhos = (manifesto.icons ?? []).map((i) => i.sizes);
  check('ícone 192', tamanhos.includes('192x192'));
  check('ícone 512', tamanhos.includes('512x512'));
  check(
    'ícone maskable',
    (manifesto.icons ?? []).some((i) => (i.purpose ?? '').includes('maskable')),
  );

  // Os ícones do manifesto precisam existir de verdade — um caminho errado
  // aqui é um manifesto válido apontando para nada.
  for (const icone of manifesto.icons ?? []) {
    const r = await page.request.get(new URL(icone.src, BASE).toString());
    check(`ícone existe: ${icone.src}`, r.ok(), `HTTP ${r.status()}`);
  }
}

// --- Service worker ---------------------------------------------------------
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { registrado: false };
  await navigator.serviceWorker.ready;
  return { registrado: true, escopo: reg.scope, ativo: !!reg.active };
});

check('service worker registrado', sw.registrado);
check('service worker ativo', !!sw.ativo);
check('escopo é a raiz', (sw.escopo ?? '').endsWith('/'), sw.escopo);

// --- A decisão que importa: API não é cacheada ------------------------------
const cacheado = await page.evaluate(async () => {
  const nomes = await caches.keys();
  const chaves = [];
  for (const nome of nomes) {
    const c = await caches.open(nome);
    for (const req of await c.keys()) chaves.push(req.url);
  }
  return chaves;
});

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
check(
  'NENHUMA resposta da API foi guardada em cache',
  !cacheado.some((u) => u.startsWith(API)),
  cacheado.filter((u) => u.startsWith(API)).join(' | '),
);
check(
  'a tela de offline está pré-carregada',
  cacheado.some((u) => u.endsWith('/offline')),
);

// --- Comportamento offline --------------------------------------------------
await context.setOffline(true);
const resposta = await page.goto(`${BASE}/historico`, { waitUntil: 'domcontentloaded' }).catch(() => null);
const textoOffline = await page.textContent('body').catch(() => '');
await context.setOffline(false);

check('offline entrega a tela de sem conexão', /Sem conexão/i.test(textoOffline ?? ''), `HTTP ${resposta?.status()}`);
check(
  'a tela offline não mostra saldo',
  !/R\$\s?\d/.test(textoOffline ?? ''),
  'um saldo antigo pareceria o atual',
);

// --- Console limpo ----------------------------------------------------------
const relevantes = erros.filter(
  (e) => !/ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e),
);
check('sem erro de console (CSP inclusive)', relevantes.length === 0, relevantes.slice(0, 2).join(' | '));

await browser.close();
process.exit(falhou ? 1 : 0);
