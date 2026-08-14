'use client';

/**
 * Ajustes.
 *
 * O modo avançado é o único lugar onde vocabulário técnico é bem-vindo
 * (requisitos §33). O resto da interface fala "saldo", "receber", "enviar".
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { type LightningStatus, api } from '../../lib/api';
import { NETWORK, loadVault } from '../../lib/device-wallet';

export default function Ajustes() {
  const [advanced, setAdvanced] = useState(false);
  const [lightning, setLightning] = useState<LightningStatus | null>(null);
  const [carteira, setCarteira] = useState<ReturnType<typeof loadVault>>(null);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    setAdvanced(localStorage.getItem('advancedMode') === 'true');
    setCarteira(loadVault());
    api.lightningStatus().then(setLightning).catch(() => setLightning(null));
    // 403 para quem não é admin: o atalho simplesmente não aparece.
    api.adminMe().then(() => setAdmin(true)).catch(() => setAdmin(false));
  }, []);

  function toggle() {
    const next = !advanced;
    setAdvanced(next);
    localStorage.setItem('advancedMode', String(next));
  }

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Ajustes</h1>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div className="tx-title">Modo avançado</div>
            <div className="tx-meta">Mostra identificadores de transação, rede e confirmações</div>
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-pressed={advanced}
            style={{
              width: 50,
              height: 29,
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: advanced ? 'var(--accent)' : 'var(--bg)',
              position: 'relative',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 3,
                left: advanced ? 24 : 3,
                width: 21,
                height: 21,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.15s ease',
              }}
            />
          </button>
        </div>
      </div>

      <div className="section-title">Segurança</div>
      <div className="card">
        <div className="review-row">
          <span className="review-label">Suas chaves</span>
          <span className="review-value">No seu dispositivo</span>
        </div>
        <div className="review-row">
          <span className="review-label">Carteira neste dispositivo</span>
          <span className="review-value">{carteira ? 'Configurada' : 'Não configurada'}</span>
        </div>
        {advanced && carteira && (
          <div className="review-row">
            <span className="review-label">Identificador</span>
            <span className="review-value" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
              {carteira.fingerprint}
            </span>
          </div>
        )}
        <div className="review-row">
          <span className="review-label">Rede</span>
          <span className="review-value">{NETWORK === 'mainnet' ? 'Liquid' : 'Liquid testnet'}</span>
        </div>
      </div>

      {!carteira ? (
        <div className="notice notice-warning">
          <strong>Este dispositivo ainda não tem sua carteira.</strong> Sem ela não dá para enviar,
          porque a assinatura acontece aqui — nunca no servidor.
          <br />
          <br />
          <Link href="/carteira" className="btn" style={{ display: 'inline-block' }}>
            Criar ou restaurar carteira
          </Link>
        </div>
      ) : (
        <div className="notice notice-info">
          Sua frase de recuperação é a única forma de recuperar o dinheiro se você perder este
          dispositivo. Como só você a tem, ninguém — nem nós — consegue recuperá-la por você.
        </div>
      )}

      <div className="section-title">Mais</div>
      <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
        <Link href="/contatos" className="action">
          <span className="action-icon" aria-hidden>
            ☰
          </span>
          Contatos
          <span className="action-hint">Endereços salvos com nome</span>
        </Link>
        <Link href="/avisos" className="action">
          <span className="action-icon" aria-hidden>
            ◔
          </span>
          Avisos
          <span className="action-hint">O que aconteceu com o seu dinheiro</span>
        </Link>
        {admin && (
          <Link href="/admin" className="action">
            <span className="action-icon" aria-hidden>
              ⚑
            </span>
            Painel
            <span className="action-hint">Conciliação e revisão</span>
          </Link>
        )}
      </div>

      <div className="section-title">Redes</div>
      <div className="card">
        <div className="review-row">
          <span className="review-label">Liquid Network</span>
          <span className="review-value" style={{ color: 'var(--accent-strong)' }}>
            Disponível
          </span>
        </div>
        <div className="review-row">
          <span className="review-label">Lightning</span>
          <span className="review-value" style={{ color: 'var(--text-muted)' }}>
            Indisponível
          </span>
        </div>
      </div>

      {lightning && (
        <div className="notice notice-info">
          {lightning.message}
          {advanced && (
            <>
              <br />
              <br />
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                {lightning.reason}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
