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

export default function Ajustes() {
  const [advanced, setAdvanced] = useState(false);
  const [lightning, setLightning] = useState<LightningStatus | null>(null);

  useEffect(() => {
    setAdvanced(localStorage.getItem('advancedMode') === 'true');
    api.lightningStatus().then(setLightning).catch(() => setLightning(null));
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
          <span className="review-label">Backup</span>
          <span className="review-value">Pendente</span>
        </div>
      </div>
      <div className="notice notice-warning">
        <strong>Faça o backup antes de receber dinheiro.</strong> Como só você tem as chaves,
        ninguém — nem nós — consegue recuperar o acesso se você perdê-las.
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
