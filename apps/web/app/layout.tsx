import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';

import './globals.css';
import { TabBar } from '../components/TabBar';
import { RegistrarServiceWorker } from '../components/RegistrarServiceWorker';

export const metadata: Metadata = {
  title: 'Carteira',
  description: 'Receba e envie Pix. Simples assim.',
  applicationName: 'Carteira',
  // O iOS ignora o manifesto para o ícone da tela de início e usa este.
  icons: {
    icon: [
      { url: '/icons/icone-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icone-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Carteira',
    // Barra de status translúcida sobre o fundo escuro do aplicativo. Com
    // `default`, o iOS desenha texto preto sobre fundo escuro e some com ele.
    statusBarStyle: 'black-translucent',
  },
  // Números longos numa carteira viram "ligar para" no iOS sem isto.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0f1115',
  // Instalado, o aplicativo ocupa a tela inteira do celular — inclusive a
  // área do entalhe. Sem isto, sobra uma faixa branca no topo.
  viewportFit: 'cover',
};

/**
 * Renderização dinâmica, por causa da CSP.
 *
 * Esta linha parece uma perda de desempenho gratuita e não é. O `middleware`
 * gera um nonce por requisição, mas o Next só aplica esse nonce aos scripts
 * que ele injeta quando a página é renderizada **por requisição**. Página
 * pré-renderizada tem HTML fixo, gerado no build, sem nonce nenhum — e a CSP
 * então bloqueia os próprios scripts de hidratação do Next.
 *
 * O sintoma é cruel: build passa, testes passam, e o aplicativo chega ao
 * usuário sem um único botão funcionando. Foi assim que este bug foi
 * encontrado — num Chromium de verdade, não numa suíte.
 *
 * O custo real é zero: todas as telas são `'use client'` e buscam os dados de
 * uma API autenticada. O HTML nunca teve conteúdo a cachear.
 */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Ler o cabeçalho é o que faz o Next associar o nonce da requisição aos
  // scripts que ele injeta nesta resposta.
  await headers();

  return (
    <html lang="pt-BR">
      <body>
        <div className="shell">{children}</div>
        <TabBar />
        <RegistrarServiceWorker />
      </body>
    </html>
  );
}
