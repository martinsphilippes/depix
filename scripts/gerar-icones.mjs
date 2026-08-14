/**
 * Renderiza os ícones do PWA a partir dos SVGs.
 *
 * Usa o Chromium que já está no projeto em vez de trazer uma biblioteca de
 * imagem — os tamanhos são poucos e o resultado é o mesmo pixel que o
 * navegador desenharia.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const DIR = 'apps/web/public/icons';
const TAREFAS = [
  { svg: 'icone.svg', saida: 'icone-192.png', tamanho: 192 },
  { svg: 'icone.svg', saida: 'icone-512.png', tamanho: 512 },
  { svg: 'icone.svg', saida: 'apple-touch-icon.png', tamanho: 180 },
  { svg: 'icone-mascarado.svg', saida: 'icone-mascarado-192.png', tamanho: 192 },
  { svg: 'icone-mascarado.svg', saida: 'icone-mascarado-512.png', tamanho: 512 },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

for (const t of TAREFAS) {
  const page = await browser.newPage({ viewport: { width: t.tamanho, height: t.tamanho } });
  const svg = readFileSync(`${DIR}/${t.svg}`, 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${t.tamanho}px;height:${t.tamanho}px}</style>${svg}`,
  );
  await page.screenshot({ path: `${DIR}/${t.saida}`, omitBackground: false });
  await page.close();
  console.log('→', t.saida, `${t.tamanho}×${t.tamanho}`);
}

await browser.close();
