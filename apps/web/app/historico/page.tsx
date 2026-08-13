'use client';

/**
 * Extrato unificado: Pix e carteira na mesma lista, em reais.
 *
 * O usuário não deveria precisar saber que existem dois trilhos por baixo.
 * O modo avançado revela TXID, confirmações e EndToEndId por transação.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type HistoryItem, api } from '../../lib/api';
import { TransactionRow } from '../../components/TransactionRow';

const PERIODOS = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'month', label: 'Este mês' },
  { id: 'all', label: 'Tudo' },
] as const;

export default function Historico() {
  const [periodo, setPeriodo] = useState<string>('30d');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAdvanced(localStorage.getItem('advancedMode') === 'true');
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .history(periodo === 'all' ? undefined : periodo)
      .then((r) => setItems(r.items))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [periodo]);

  const agrupado = groupByDay(items);

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Extrato</h1>

      <div className="filters">
        {PERIODOS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="filter"
            data-active={periodo === p.id}
            onClick={() => setPeriodo(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      {loading ? (
        <div className="empty">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="empty">Nenhuma movimentação neste período.</div>
      ) : (
        Object.entries(agrupado).map(([dia, doDia]) => (
          <section key={dia}>
            <div className="section-title">{dia}</div>
            <div className="card">
              {doDia.map((item) => (
                <TransactionRow key={item.transactionId} item={item} advanced={advanced} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function groupByDay(items: HistoryItem[]): Record<string, HistoryItem[]> {
  const out: Record<string, HistoryItem[]> = {};
  for (const item of items) {
    const date = new Date(item.createdAt);
    const key = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
    (out[key] ??= []).push(item);
  }
  return out;
}
