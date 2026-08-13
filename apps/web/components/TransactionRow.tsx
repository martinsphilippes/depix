'use client';

import { useState } from 'react';

import type { HistoryItem } from '../lib/api';

const ICONS: Record<string, string> = {
  pix_in_to_depix: '↓',
  depix_receive: '←',
  depix_out_to_pix: '↑',
  depix_send: '→',
  swap: '⇄',
  fee: '·',
  adjustment: '±',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Hoje, ${time}` : `${date.toLocaleDateString('pt-BR')}, ${time}`;
}

export function TransactionRow({ item, advanced = false }: { item: HistoryItem; advanced?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const concluded = item.status === 'COMPLETED';

  return (
    <div className="tx">
      <span className="tx-icon" aria-hidden>
        {ICONS[item.kind] ?? '·'}
      </span>

      <div className="tx-body">
        <div className="tx-title">{item.title}</div>
        <div className="tx-meta">
          {formatWhen(item.createdAt)}
          {/* O rótulo de status só aparece quando ainda não terminou —
              repetir "Concluída" em toda linha é ruído. */}
          {!concluded && ` · ${item.statusLabel}`}
        </div>

        {advanced && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'none',
                border: 'none',
                padding: '4px 0 0',
                font: 'inherit',
                fontSize: 12,
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Ocultar detalhes' : 'Detalhes técnicos'}
            </button>

            {expanded && (
              <div className="technical">
                <div>ID interno: {item.transactionId}</div>
                <div>Ativo: {item.technical.assetCode}</div>
                {item.technical.txid && <div>TXID: {item.technical.txid}</div>}
                {item.technical.confirmations !== null && (
                  <div>Confirmações: {item.technical.confirmations}</div>
                )}
                {item.technical.e2eId && <div>EndToEndId: {item.technical.e2eId}</div>}
                {item.technical.providerRef && <div>Provider: {item.technical.providerRef}</div>}
                {item.counterparty && <div>Contraparte: {item.counterparty}</div>}
                <div>Status: {item.status}</div>
              </div>
            )}
          </>
        )}
      </div>

      <span className={`tx-amount ${item.direction === 'in' ? 'in' : ''}`}>{item.amountLabel}</span>
    </div>
  );
}
