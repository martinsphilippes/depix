/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `@depix/wallet` e `@depix/core` são workspaces em TypeScript sem build
  // próprio. O Next transpila os dois no bundle do cliente — que é onde eles
  // têm de rodar: assinatura no dispositivo, não no servidor.
  transpilePackages: [
    '@depix/wallet',
    '@depix/core',
    // A API roda como função serverless dentro do Next (app/api/[[...path]]),
    // então os pacotes dela também passam pelo transpile.
    '@depix/api',
    '@depix/app',
    '@depix/firestore',
    '@depix/ledger',
    '@depix/providers',
  ],

  // Módulos nativos e pesados ficam fora do bundle e são carregados em tempo
  // de execução. `@node-rs/argon2` é binário; empacotá-lo quebra.
  serverExternalPackages: ['@node-rs/argon2', '@google-cloud/firestore', 'fastify'],

  webpack: (config) => {
    // O LWK é um módulo WebAssembly. Sem isto, o import de `lwk_wasm` falha
    // no build com "WebAssembly module is included ... but experiment is not
    // enabled".
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },

  // Cabeçalhos de segurança (SECURITY.md §4).
  //
  // ⚠️ A **CSP não está aqui** — ela vive em `middleware.ts`, porque precisa
  // de um nonce por requisição. Uma CSP estática sem `unsafe-inline` bloqueia
  // os scripts de hidratação do Next e entrega uma página morta; com
  // `unsafe-inline` devolveria ao atacante a capacidade que a CSP existe para
  // tirar. O nonce é a saída que não abre mão de nenhuma das duas coisas.
  //
  // Os cabeçalhos abaixo são estáticos porque não dependem da requisição.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // A câmera é usada pelo leitor de QR (§28); microfone e localização
          // não têm por que existir numa carteira.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Isolamento de origem: sem isto, uma página aberta por nós (ou que
          // nos abra) compartilha o mesmo grupo de contexto de navegação e
          // pode alcançar este `window`. Numa aba que segura a seed em
          // memória durante a assinatura, isso importa.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
