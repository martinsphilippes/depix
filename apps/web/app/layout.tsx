import type { Metadata, Viewport } from 'next';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <div className="shell">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
