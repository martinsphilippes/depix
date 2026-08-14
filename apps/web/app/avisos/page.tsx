'use client';

/**
 * Avisos (§30).
 *
 * Buscados do servidor, não empurrados por push — a escolha é de privacidade
 * e está explicada em `packages/app/src/services/notifications.ts`. Para o
 * usuário, o efeito visível é que os avisos aparecem quando ele abre o app, e
 * não no celular com o app fechado. Vale dizer isso na própria tela em vez de
 * deixá-lo achando que o aviso se perdeu.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type AppNotification, api } from '../../lib/api';

const ICONE: Record<string, string> = {
  deposit_confirmed: '↓',
  send_confirmed: '↑',
  send_failed: '!',
  deposit_expired: '⏱',
  security_alert: '⚠',
};

export default function Avisos() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function marcarTodas() {
    await api.markAllNotificationsRead();
    setItems((atuais) => atuais.map((n) => ({ ...n, read: true })));
    setUnread(0);
  }

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Avisos</h1>

      {error && <div className="notice notice-danger">{error}</div>}

      {unread > 0 && (
        <button type="button" className="btn btn-secondary" onClick={marcarTodas}>
          Marcar todas como lidas ({unread})
        </button>
      )}

      {loading ? (
        <div className="empty">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="empty">Nenhum aviso por enquanto.</div>
      ) : (
        <div className="card">
          {items.map((n) => (
            <div
              key={n.id}
              className="review-row"
              style={{
                alignItems: 'flex-start',
                gap: 12,
                opacity: n.read ? 0.6 : 1,
                cursor: n.read ? 'default' : 'pointer',
              }}
              onClick={() => {
                if (n.read) return;
                void api.markNotificationRead(n.id).then(() => {
                  setItems((atuais) =>
                    atuais.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
                  );
                  setUnread((u) => Math.max(0, u - 1));
                });
              }}
            >
              <span className="action-icon" aria-hidden style={{ flexShrink: 0 }}>
                {ICONE[n.kind] ?? '•'}
              </span>
              <span style={{ flex: 1 }}>
                <span className="tx-title">{n.title}</span>
                <br />
                <span className="tx-meta">{n.body}</span>
                <br />
                <span className="tx-meta">{new Date(n.createdAt).toLocaleString('pt-BR')}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="notice notice-info">
        Os avisos aparecem aqui quando você abre o aplicativo. Não enviamos notificação para o seu
        celular porque isso exigiria contar a um serviço de terceiros quando você movimenta
        dinheiro — e nós preferimos não contar.
      </div>
    </>
  );
}
