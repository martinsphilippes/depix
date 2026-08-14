import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';

import './globals.css';
import { TabBar } from '../components/TabBar';

export const metadata: Metadata = {
  title: 'Carteira',
  description: 'Receba e envie Pix. Simples assim.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0f1115',
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
      </body>
    </html>
  );
}
