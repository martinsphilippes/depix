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

import { ApiRequestError, type HistoryItem, type WalletBalance, api } from '../lib/api';
import { TransactionRow } from '../components/TransactionRow';
import { hasWallet } from '../lib/device-wallet';

export default function Dashboard() {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [semSessao, setSemSessao] = useState(false);
  const [semCarteira, setSemCarteira] = useState(false);
  const [naoLidos, setNaoLidos] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setSemCarteira(!hasWallet());

    // Falha em silêncio: um contador de avisos indisponível não deve
    // atrapalhar quem só quer ver o saldo.
    api.notifications().then((r) => setNaoLidos(r.unread)).catch(() => undefined);

    Promise.all([api.balance(), api.history()])
      .then(([b, h]) => {
        setBalance(b);
        setRecent(h.items.slice(0, 6));
      })
      .catch((err: Error) => {
        // Não ter sessão não é erro de sistema: é o estado normal de quem
        // ainda não entrou. Mandar para a tela de entrada é mais útil do que
        // exibir "Sessão ausente" em vermelho.
        if (err instanceof ApiRequestError && err.status === 401) {
          setSemSessao(true);
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (!loading && semSessao) {
    return (
      <>
        <header className="topbar">
          <span className="brand">Carteira</span>
        </header>
        <div className="empty" style={{ marginTop: 40 }}>
          Entre para ver seu saldo.
        </div>
        <Link href="/entrar" className="btn" style={{ display: 'block', textAlign: 'center' }}>
          Entrar ou criar conta
        </Link>
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">Carteira</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link
            href="/avisos"
            aria-label={naoLidos > 0 ? `${naoLidos} avisos não lidos` : 'Avisos'}
            style={{ position: 'relative', textDecoration: 'none', fontSize: 18 }}
          >
            <span aria-hidden>◔</span>
            {naoLidos > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -8,
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '16px',
                  textAlign: 'center',
                }}
              >
                {naoLidos > 9 ? '9+' : naoLidos}
              </span>
            )}
          </Link>
          <span className="env-badge">Sandbox</span>
        </span>
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

      {/* Sem carteira no dispositivo dá para ver saldo, mas não dá para
          enviar — a assinatura acontece aqui. Melhor dizer isso antes de o
          usuário montar um envio e esbarrar. */}
      {!loading && semCarteira && (
        <div className="notice notice-warning" style={{ marginTop: 20 }}>
          <strong>Este dispositivo ainda não tem sua carteira.</strong>
          <br />
          Sem ela não é possível enviar, porque a assinatura acontece aqui e não no servidor.
          <br />
          <br />
          <Link href="/carteira" className="btn" style={{ display: 'inline-block' }}>
            Criar ou restaurar carteira
          </Link>
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
