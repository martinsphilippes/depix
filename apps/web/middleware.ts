/**
 * CSP com nonce por requisição.
 *
 * ## Por que isto existe
 *
 * A CSP estava declarada em `next.config.mjs` como cabeçalho estático, com
 * `script-src 'self' 'wasm-unsafe-eval'`. Parecia certo, o build passava e os
 * testes passavam — e o aplicativo **não funcionava no navegador**: o Next
 * injeta scripts inline para hidratar o React (`self.__next_f.push(...)`), a
 * CSP os bloqueava, e a página chegava sem um único botão.
 *
 * Nada disso aparece em teste de unidade nem no build. Apareceu num Chromium
 * de verdade, e é por isso que existe `.smoke-web.mjs`.
 *
 * ## Por que nonce e não `unsafe-inline`
 *
 * `'unsafe-inline'` resolveria em uma linha e devolveria ao atacante
 * exatamente a capacidade que a CSP existe para tirar: injetar `<script>` na
 * página. Numa carteira non-custodial, a página é onde a seed fica em memória
 * durante a assinatura — a CSP aqui não é boa prática, é controle de custódia
 * (SECURITY.md §4).
 *
 * O nonce é gerado por requisição, vai no cabeçalho e o Next o aplica aos
 * próprios scripts. Script injetado por XSS não tem o nonce e não executa.
 *
 * ## O custo, declarado
 *
 * Nonce por requisição significa render dinâmico: as páginas deixam de ser
 * pré-renderizadas estaticamente. Para um aplicativo que é todo client-side e
 * fala com uma API autenticada, não há perda real — o HTML nunca teve
 * conteúdo a cachear.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * `next dev` usa `eval` para o refresh rápido, o que a CSP recusa.
 *
 * O afrouxamento é restrito ao desenvolvimento e não chega a produção: em
 * produção `NODE_ENV` é `production` e a diretiva sai. Vale notar que isto é
 * o oposto do gate do servidor, que falha fechado — aqui, falhar fechado
 * significaria não conseguir desenvolver.
 */
const DEV = process.env.NODE_ENV === 'development';

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    "default-src 'self'",
    // `wasm-unsafe-eval`: sem ele não há LWK, logo não há assinatura no
    // dispositivo — e a única alternativa seria assinar no servidor, que é o
    // que a arquitetura recusa. Permite compilar WebAssembly e NÃO reabilita
    // `eval` para JavaScript.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${DEV ? " 'unsafe-eval'" : ''}`,
    // `style-src` ainda aceita inline: o Next injeta estilos críticos inline e
    // não os assina com o nonce. CSS injetado não executa código; o risco é
    // de exfiltração por seletor, muito menor que o de script arbitrário.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // Dois destinos: a nossa API e o Esplora, que é como o dispositivo lê
    // UTXOs e transmite. Sem o segundo, a carteira dependeria do nosso
    // servidor para alcançar a rede.
    `connect-src 'self' ${API_URL} https://blockstream.info`,
    // A câmera do leitor de QR entrega quadros por `blob:`/`mediastream:`.
    "media-src 'self' blob: mediastream:",
    // O service worker é script, e `script-src` sozinho não o cobre: sem
    // `worker-src`, o navegador recusa registrá-lo e o aplicativo deixa de ser
    // instalável — sem erro visível na página.
    "worker-src 'self'",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  // O Next lê o nonce do próprio cabeçalho de CSP da requisição e o aplica
  // aos scripts que injeta. Sem repassar aqui, ele não teria como saber.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Tudo, menos os estáticos: eles não carregam script inline, não precisam
  // de nonce, e passar cada um pelo middleware custaria por requisição.
  //
  // `sw.js` também fica de fora, e por um motivo específico: o service worker
  // é servido do escopo raiz e o middleware não deve reescrever nada nele.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|icons/).*)'],
};
