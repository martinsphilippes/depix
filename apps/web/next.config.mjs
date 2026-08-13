/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cabeçalhos de segurança (SECURITY.md §4). A CSP restritiva não é
  // "boa prática" numa carteira non-custodial: é controle de custódia.
  // Um XSS aqui pode roubar a seed em memória, então qualquer afrouxamento
  // precisa de justificativa registrada.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' " + (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'),
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
        ],
      },
    ];
  },
};

export default nextConfig;
