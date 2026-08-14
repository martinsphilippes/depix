/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `@depix/wallet` e `@depix/core` são workspaces em TypeScript sem build
  // próprio. O Next transpila os dois no bundle do cliente — que é onde eles
  // têm de rodar: assinatura no dispositivo, não no servidor.
  transpilePackages: ['@depix/wallet', '@depix/core'],

  webpack: (config) => {
    // O LWK é um módulo WebAssembly. Sem isto, o import de `lwk_wasm` falha
    // no build com "WebAssembly module is included ... but experiment is not
    // enabled".
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },

  // Cabeçalhos de segurança (SECURITY.md §4). A CSP restritiva não é
  // "boa prática" numa carteira non-custodial: é controle de custódia.
  // Um XSS aqui pode roubar a seed em memória, então qualquer afrouxamento
  // precisa de justificativa registrada.
  async headers() {
    const csp = [
      "default-src 'self'",
      // `wasm-unsafe-eval` é o afrouxamento que a carteira exige, e vale a
      // justificativa: compilar WebAssembly é bloqueado por `script-src
      // 'self'` sozinho, e sem WebAssembly não há LWK — logo, não há
      // assinatura no dispositivo, e a única alternativa seria assinar no
      // servidor, que é justamente o que a arquitetura recusa.
      //
      // O token permite compilar wasm; NÃO reabilita `eval` nem
      // `new Function` para JavaScript. É estritamente menos permissivo que
      // `unsafe-eval`, que continua fora.
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      // O dispositivo fala com dois destinos: a nossa API e o Esplora, que é
      // como ele lê UTXOs e transmite a transação. Sem o segundo, a carteira
      // dependeria do nosso servidor para chegar à rede — e deixaria de ser
      // non-custodial em qualquer sentido prático.
      "connect-src 'self' " +
        [
          process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
          'https://blockstream.info',
        ].join(' '),
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
