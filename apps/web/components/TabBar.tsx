'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Início', icon: '⌂' },
  { href: '/receber', label: 'Receber', icon: '↓' },
  { href: '/enviar', label: 'Enviar', icon: '↑' },
  { href: '/historico', label: 'Extrato', icon: '≡' },
  { href: '/ajustes', label: 'Ajustes', icon: '⚙' },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="tabbar">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} className="tab" data-active={pathname === tab.href}>
          <span className="tab-icon" aria-hidden>
            {tab.icon}
          </span>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
