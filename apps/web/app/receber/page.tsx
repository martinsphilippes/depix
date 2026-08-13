'use client';

/**
 * Receber.
 *
 * Duas opções: Pix (o operador converte e manda para a carteira do usuário)
 * e DePix direto (endereço da própria carteira). Lightning aparece como
 * indisponível, com o motivo — em vez de um botão que falha.
 */

import Link from 'next/link';
import { useState } from 'react';

import { ApiRequestError, type DepositIntent, api } from '../../lib/api';

type Modo = 'escolha' | 'pix' | 'carteira';

export default function Receber() {
  const [modo, setModo] = useState<Modo>('escolha');

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Receber</h1>

      {modo === 'escolha' && <Escolha onSelect={setModo} />}
      {modo === 'pix' && <ReceberPix />}
      {modo === 'carteira' && <ReceberCarteira />}
    </>
  );
}

function Escolha({ onSelect }: { onSelect: (m: Modo) => void }) {
  return (
    <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
      <button type="button" className="action" onClick={() => onSelect('pix')}>
        <span className="action-icon" aria-hidden>
          ↓
        </span>
        Receber por Pix
        <span className="action-hint">Gere um QR Code para quem vai te pagar</span>
      </button>

      <button type="button" className="action" onClick={() => onSelect('carteira')}>
        <span className="action-icon" aria-hidden>
          ←
        </span>
        Receber de outra carteira
        <span className="action-hint">Endereço para transferência entre carteiras</span>
      </button>

      {/* Botão presente, mas honesto sobre o estado da integração. */}
      <div className="action" aria-disabled="true">
        <span className="action-icon" aria-hidden>
          ⚡
        </span>
        Lightning
        <span className="action-hint">Ainda não disponível para esta carteira</span>
      </div>
    </div>
  );
}

function ReceberPix() {
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [intent, setIntent] = useState<DepositIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function gerar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setIntent(await api.createDeposit(amount, address));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível gerar a cobrança');
    } finally {
      setBusy(false);
    }
  }

  if (intent) {
    return (
      <>
        {intent.sandbox && (
          <div className="notice notice-warning">
            <strong>Ambiente de testes.</strong> Este código não é pagável e nenhum dinheiro real
            será movimentado.
          </div>
        )}

        <div className="card">
          <div className="balance-label">Valor a receber</div>
          <div className="balance-value" style={{ fontSize: 30 }}>
            {intent.amount}
          </div>
          <div className="balance-sub">{intent.status}</div>
        </div>

        <div className="section-title">Pix copia e cola</div>
        <div className="copy-box">{intent.qrCopyPaste}</div>

        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(intent.qrCopyPaste);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? 'Copiado ✓' : 'Copiar código'}
        </button>

        <div className="notice notice-info" style={{ marginTop: 16 }}>
          Assim que o pagamento for confirmado, o valor aparece no seu saldo automaticamente.
          Você não precisa manter esta tela aberta.
        </div>
      </>
    );
  }

  return (
    <form onSubmit={gerar}>
      <div className="field">
        <label htmlFor="amount">Quanto você quer receber?</label>
        <input
          id="amount"
          inputMode="decimal"
          placeholder="0,00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="address">Endereço da sua carteira</label>
        <input
          id="address"
          placeholder="lq1..."
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        {/* O endereço é do próprio usuário: o valor vai direto para ele,
            sem passar pela nossa custódia. */}
        <div className="tx-meta" style={{ marginTop: 7 }}>
          O valor vai direto para a sua carteira. Nós não guardamos o seu dinheiro.
        </div>
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      <button type="submit" className="btn" disabled={busy || !amount || !address}>
        {busy ? 'Gerando…' : 'Gerar cobrança'}
      </button>
    </form>
  );
}

function ReceberCarteira() {
  return (
    <>
      <div className="notice notice-warning">
        <strong>Atenção à rede.</strong> Envie apenas DePix pela rede Liquid para este endereço.
        Valores enviados por outra rede não podem ser recuperados.
      </div>

      <div className="card">
        <div className="review-row">
          <span className="review-label">Rede</span>
          <span className="review-value">Liquid Network</span>
        </div>
        <div className="review-row">
          <span className="review-label">Moeda aceita</span>
          <span className="review-value">DePix</span>
        </div>
      </div>

      <div className="notice notice-info">
        A geração de endereço acontece no seu dispositivo, a partir da sua chave — por isso
        depende da carteira estar desbloqueada. Esta tela será conectada à assinatura local na
        próxima etapa.
      </div>
    </>
  );
}
