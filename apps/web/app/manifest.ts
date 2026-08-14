import type { MetadataRoute } from 'next';

/**
 * Manifesto do PWA.
 *
 * `display: 'standalone'` é o que faz o sistema abrir sem barra de endereço,
 * como aplicativo. Isso tem uma consequência de segurança que vale registrar:
 * sem a barra, o usuário **perde a única pista visual** de qual site está
 * usando. É a troca que todo PWA financeiro faz, e o que a compensa aqui é a
 * passkey: ela é amarrada à origem pelo navegador, então um site clonado não
 * consegue usá-la nem que o usuário não perceba a diferença.
 *
 * `id` fixo importa: sem ele, o sistema identifica o aplicativo pela
 * `start_url`, e mudar a rota inicial no futuro criaria um segundo aplicativo
 * em vez de atualizar o existente.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Carteira',
    short_name: 'Carteira',
    description: 'Receba e envie Pix. Simples assim.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Mesma cor do `viewport.themeColor` do layout: divergir faz a barra de
    // status piscar de uma cor para outra na abertura.
    theme_color: '#0f1115',
    background_color: '#0f1115',
    lang: 'pt-BR',
    dir: 'ltr',
    categories: ['finance'],
    icons: [
      { src: '/icons/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // `maskable` tem margem própria: o Android recorta o ícone num formato
      // que varia por fabricante, e sem a variante ele cortaria o desenho.
      {
        src: '/icons/icone-mascarado-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icone-mascarado-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    // Atalhos do menu de contexto do ícone. Só as duas ações que alguém abre o
    // aplicativo para fazer — uma lista longa aqui vira ruído.
    shortcuts: [
      {
        name: 'Receber',
        short_name: 'Receber',
        url: '/receber',
        icons: [{ src: '/icons/icone-192.png', sizes: '192x192' }],
      },
      {
        name: 'Enviar',
        short_name: 'Enviar',
        url: '/enviar',
        icons: [{ src: '/icons/icone-192.png', sizes: '192x192' }],
      },
    ],
  };
}
