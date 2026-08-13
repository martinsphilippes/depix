'use client';

/**
 * Dashboard.
 *
 * O saldo aparece em reais e nada mais. "DePix", "Liquid" e "confirmações"
 * não têm lugar nesta tela — quem quiser vê-los liga o modo avançado
 * (requisitos §31 e §32).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type HistoryItem, type WalletBalance, api } from '../lib/api';
import { TransactionRow } from '../components/TransactionRow';

export default function Dashboard() {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.balance(), api.history()])
      .then(([b, h]) => {
        setBalance(b);
        setRecent(h.items.slice(0, 6));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand">Carteira</span>
        <span className="env-badge">Sandbox</span>
      </header>

      <section>
        <div className="balance-label">Saldo disponível</div>
        <div className="balance-value">{loading ? '—' : (balance?.total ?? 'R$ 0,00')}</div>
        {balance && balance.pendingIn !== 'R$ 0,00' && (
          <div className="balance-sub">{balance.pendingIn} a caminho</div>
        )}
      </section>

      {error && (
        <div className="notice notice-danger" style={{ marginTop: 20 }}>
          Não foi possível carregar seus dados. {error}
        </div>
      )}

      <div className="actions">
        <Link href="/receber" className="action">
          <span className="action-icon" aria-hidden>
            ↓
          </span>
          Receber
          <span className="action-hint">Por Pix ou carteira</span>
        </Link>
        <Link href="/enviar" className="action">
          <span className="action-icon" aria-hidden>
            ↑
          </span>
          Enviar
          <span className="action-hint">Pix ou carteira</span>
        </Link>
      </div>

      <div className="section-title">Atividade recente</div>

      {loading ? (
        <div className="empty">Carregando…</div>
      ) : recent.length === 0 ? (
        <div className="empty">
          Nenhuma movimentação ainda.
          <br />
          Que tal <Link href="/receber" style={{ color: 'var(--accent-strong)' }}>receber seu primeiro Pix</Link>?
        </div>
      ) : (
        <div className="card">
          {recent.map((item) => (
            <TransactionRow key={item.transactionId} item={item} />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <Link href="/historico" className="btn btn-secondary" style={{ display: 'block', textAlign: 'center' }}>
          Ver extrato completo
        </Link>
      )}
    </>
  );
}
