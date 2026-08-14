/**
 * Service worker.
 *
 * ## A decisão que governa este arquivo
 *
 * **Nenhuma resposta da API é guardada em cache. Nunca.**
 *
 * É a regra inteira, e ela contraria o que quase todo tutorial de PWA ensina.
 * O padrão comum — "stale-while-revalidate", devolve o cache e atualiza
 * depois — é ótimo para um blog e inaceitável aqui: significaria mostrar um
 * saldo antigo como se fosse o atual. Um usuário que vê R$ 1.200 num aplicativo
 * offline e conclui que pode gastar não foi ajudado pelo cache; foi enganado
 * por ele.
 *
 * O mesmo vale para o extrato, os limites, os contatos e os avisos. Nenhum
 * deles é seguro de mostrar desatualizado sem dizer que está desatualizado — e
 * dizer isso na interface é bem mais trabalho do que simplesmente não guardar.
 *
 * Então:
 *
 *   • **assets estáticos** (`/_next/static/*`, ícones, o wasm do LWK) — cache
 *     agressivo. São imutáveis: o nome do arquivo carrega o hash do conteúdo,
 *     então uma versão nova tem outro nome e nunca colide com a antiga.
 *   • **navegação** — rede primeiro; sem rede, a tela de offline. O usuário
 *     descobre que está sem conexão, em vez de ver uma tela que parece normal.
 *   • **API** — o service worker não intercepta. Nem cacheia, nem tenta ser
 *     esperto. A requisição vai direto, e falha honestamente se não houver rede.
 *
 * ## Sobre a chave privada
 *
 * O service worker nunca vê a frase de recuperação: ela é cifrada no
 * `localStorage`, que ele não acessa, e só é decifrada na página. Este arquivo
 * não deve nunca passar a manipular material de chave — se algum dia precisar,
 * a decisão merece uma revisão de segurança inteira, não um commit.
 */

const VERSAO = 'v1';
const CACHE_ESTATICO = `carteira-estatico-${VERSAO}`;
const CACHE_SHELL = `carteira-shell-${VERSAO}`;

/** Página mostrada quando não há rede. Precisa existir antes de ser útil. */
const OFFLINE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);
      // Só a tela de offline. Pré-carregar as outras rotas seria pré-carregar
      // HTML que depende de sessão — e serviria uma versão vazia para quem
      // está logado.
      await cache.add(new Request(OFFLINE, { cache: 'reload' }));
    })(),
  );
  // Assume o controle sem esperar a aba antiga fechar: numa carteira, ficar
  // com duas versões do código em execução é pedir por bug difícil.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches de versões anteriores. Sem isto, cada publicação deixa
      // lixo permanente no dispositivo do usuário.
      const nomes = await caches.keys();
      await Promise.all(
        nomes
          .filter((n) => n.startsWith('carteira-') && !n.endsWith(VERSAO))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Assets com hash no nome: imutáveis, seguros de guardar para sempre. */
function ehEstaticoImutavel(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.wasm')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só GET. Um POST em cache seria um envio repetido — a pior falha possível
  // aqui.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Outra origem: a nossa API e o Esplora. Não interceptamos. O service worker
  // não tem o que acrescentar a uma chamada de dinheiro, e teria muito o que
  // estragar.
  if (url.origin !== self.location.origin) return;

  if (ehEstaticoImutavel(url)) {
    event.respondWith(cacheePrimeiro(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(redePrimeiroComOffline(request));
  }
  // Todo o resto segue direto para a rede, sem interceptação.
});

async function cacheePrimeiro(request) {
  const cache = await caches.open(CACHE_ESTATICO);
  const guardado = await cache.match(request);
  if (guardado) return guardado;

  const resposta = await fetch(request);
  // Só guarda o que deu certo: cachear um 404 ou um 500 é fixar o erro.
  if (resposta.ok) cache.put(request, resposta.clone());
  return resposta;
}

async function redePrimeiroComOffline(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_SHELL);
    const offline = await cache.match(OFFLINE);

    // A tela de offline sai com o status que tinha quando foi guardada (200).
    // É o comportamento padrão e o que os navegadores esperam de um fallback
    // de navegação — o usuário vê uma página, não um erro de protocolo.
    //
    // O 503 abaixo é para o caso de o próprio fallback faltar: aí não há
    // página nenhuma a entregar, e dizer 200 seria mentira.
    return offline ?? new Response('Sem conexão.', { status: 503 });
  }
}
