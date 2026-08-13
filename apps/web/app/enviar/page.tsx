'use client';

/**
 * Enviar.
 *
 * A tela de Pix é onde a ausência do DICT aparece para o usuário. Em vez de
 * exibir um nome de recebedor que não temos, mostramos a chave digitada em
 * destaque e explicamos o que acontece se ela estiver errada. Interface
 * honesta em vez de bonita.
 */

import Link from 'next/link';
import { useState } from 'react';

import { ApiRequestError, type PixKeyPreview, type SendReview, api } from '../../lib/api';

type Modo = 'escolha' | 'pix' | 'carteira';

export default function Enviar() {
  const [modo, setModo] = useState<Modo>('escolha');

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Enviar</h1>

      {modo === 'escolha' && (
        <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
          <button type="button" className="action" onClick={() => setModo('pix')}>
            <span className="action-icon" aria-hidden>
              ↑
            </span>
            Enviar Pix
            <span className="action-hint">Para uma conta bancária</span>
          </button>

          <button type="button" className="action" onClick={() => setModo('carteira')}>
            <span className="action-icon" aria-hidden>
              →
            </span>
            Enviar para outra carteira
            <span className="action-hint">Transferência entre carteiras</span>
          </button>

          <div className="action" aria-disabled="true">
            <span className="action-icon" aria-hidden>
              ⚡
            </span>
            Lightning
            <span className="action-hint">Ainda não disponível para esta carteira</span>
          </div>
        </div>
      )}

      {modo === 'pix' && <EnviarPix />}
      {modo === 'carteira' && <EnviarCarteira />}
    </>
  );
}

function EnviarPix() {
  const [pixKey, setPixKey] = useState('');
  const [preview, setPreview] = useState<PixKeyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function consultar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewPixKey(pixKey));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível verificar a chave');
    } finally {
      setBusy(false);
    }
  }

  if (preview) {
    return (
      <>
        <div className="card">
          <div className="review-row">
            <span className="review-label">Chave Pix</span>
            <span className="review-value">{preview.keyMasked}</span>
          </div>
          <div className="review-row">
            <span className="review-label">Tipo</span>
            <span className="review-value">{TIPO_LABEL[preview.keyType] ?? preview.keyType}</span>
          </div>
        </div>

        {/* Onde estaria "Nome: João da Silva". Não temos esse dado e não
            vamos inventá-lo — ver ARCHITECTURE.md §4. */}
        <div className="notice notice-warning">
          <strong>Confira a chave com atenção.</strong>
          <br />
          {preview.notice}
        </div>

        <div className="notice notice-info">
          Esta etapa depende da carteira assinar a transação no seu dispositivo, e será conectada
          na próxima entrega.
        </div>

        <button type="button" className="btn btn-secondary" onClick={() => setPreview(null)}>
          Corrigir chave
        </button>
      </>
    );
  }

  return (
    <form onSubmit={consultar}>
      <div className="field">
        <label htmlFor="pixKey">Chave Pix do destinatário</label>
        <input
          id="pixKey"
          placeholder="CPF, e-mail, telefone ou chave aleatória"
          value={pixKey}
          onChange={(e) => setPixKey(e.target.value)}
          autoFocus
        />
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      <button type="submit" className="btn" disabled={busy || !pixKey}>
        {busy ? 'Verificando…' : 'Continuar'}
      </button>
    </form>
  );
}

const TIPO_LABEL: Record<string, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Telefone',
  random: 'Chave aleatória',
  unknown: 'Formato não reconhecido',
};

function EnviarCarteira() {
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<SendReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function revisar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setReview(await api.prepareSend(amount, address));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível preparar o envio');
    } finally {
      setBusy(false);
    }
  }

  if (review) {
    return (
      <>
        <div className="section-title">Revise seu envio</div>

        <div className="card">
          <div className="review-row">
            <span className="review-label">Para</span>
            <span className="review-value" style={{ fontSize: 12 }}>
              {review.destination}
            </span>
          </div>
          <div className="review-row">
            <span className="review-label">Rede</span>
            <span className="review-value">{review.network}</span>
          </div>
          <div className="review-row">
            <span className="review-label">Valor</span>
            <span className="review-value">{review.amount}</span>
          </div>
          {/* A taxa é sempre exibida antes da confirmação (requisitos §26). */}
          <div className="review-row">
            <span className="review-label">Taxa</span>
            <span className="review-value">{review.fee}</span>
          </div>
          <div className="review-row total">
            <span className="review-label">Total</span>
            <span className="review-value">{review.total}</span>
          </div>
          <div className="review-row">
            <span className="review-label">Saldo após o envio</span>
            <span className="review-value">{review.remainingAfter}</span>
          </div>
        </div>

        <div className="notice notice-info">
          O valor já foi reservado. A transação precisa ser assinada no seu dispositivo — nosso
          servidor não tem acesso à sua chave e não consegue assinar por você.
        </div>

        <button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>
          Voltar
        </button>
      </>
    );
  }

  return (
    <form onSubmit={revisar}>
      <div className="field">
        <label htmlFor="dest">Endereço de destino</label>
        <input
          id="dest"
          placeholder="lq1..."
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="valor">Valor</label>
        <input
          id="valor"
          inputMode="decimal"
          placeholder="0,00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      <button type="submit" className="btn" disabled={busy || !address || !amount}>
        {busy ? 'Calculando…' : 'Revisar envio'}
      </button>
    </form>
  );
}
