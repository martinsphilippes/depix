'use client';

/**
 * Contatos (§29).
 *
 * A tela existe para dois usos e trata os dois de forma diferente de
 * propósito.
 *
 * **Renomear** é trivial e acontece direto. **Trocar o endereço** é operação
 * de segurança: exige confirmação por passkey, porque é o passo do ataque em
 * que alguém com a sessão redireciona pagamentos futuros contando com a
 * vítima conferir só o nome. A tela diz isso antes, não depois do erro.
 *
 * O endereço é mostrado por inteiro em fonte monoespaçada, e não abreviado
 * com reticências no meio. Abreviar é bonito e esconde exatamente os
 * caracteres que um ataque de substituição mantém iguais nas pontas.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiRequestError, type Contact, api } from '../../lib/api';
import { QrScanButton, QrScanner } from '../../components/QrScanner';
import { PasskeyCancelled, reauth } from '../../lib/passkey';

export default function Contatos() {
  const [contatos, setContatos] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [destino, setDestino] = useState('');
  const [lendoQr, setLendoQr] = useState(false);
  const [editando, setEditando] = useState<Contact | null>(null);
  const [novoDestino, setNovoDestino] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .contacts()
      .then((r) => setContatos(r.contacts))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function adicionar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const novo = await api.saveContact(label.trim(), destino.trim());
      setContatos((atuais) => [...atuais.filter((c) => c.id !== novo.id), novo]);
      setLabel('');
      setDestino('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Troca de endereço com confirmação.
   *
   * A API recusa com `reauth_required` e a tela responde com a cerimônia, em
   * vez de mostrar o erro cru: para o usuário legítimo isto é um passo a
   * mais, não uma parede.
   */
  async function trocarEndereco() {
    if (!editando) return;
    setBusy(true);
    setError(null);

    const aplicar = () => api.changeContactDestination(editando.id, novoDestino.trim());

    try {
      let atualizado: Contact;
      try {
        atualizado = await aplicar();
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'reauth_required') {
          await reauth();
          atualizado = await aplicar();
        } else {
          throw err;
        }
      }

      setContatos((atuais) => [
        ...atuais.filter((c) => c.id !== editando.id && c.id !== atualizado.id),
        atualizado,
      ]);
      setEditando(null);
      setNovoDestino('');
    } catch (err) {
      setError(
        err instanceof PasskeyCancelled
          ? 'Confirmação cancelada. O endereço não foi alterado.'
          : err instanceof Error
            ? err.message
            : 'Não foi possível alterar',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remover(c: Contact) {
    await api.deleteContact(c.id).catch(() => undefined);
    setContatos((atuais) => atuais.filter((x) => x.id !== c.id));
  }

  if (lendoQr) {
    return (
      <QrScanner
        onScan={(lido) => {
          setLendoQr(false);
          if (lido.kind === 'liquid_address') {
            if (editando) setNovoDestino(lido.value);
            else setDestino(lido.value);
          } else {
            setError('Não reconheci este código como endereço Liquid.');
          }
        }}
        onClose={() => setLendoQr(false)}
      />
    );
  }

  if (editando) {
    return (
      <>
        <button
          type="button"
          className="back"
          onClick={() => {
            setEditando(null);
            setError(null);
          }}
        >
          ← Voltar
        </button>
        <h1>Alterar endereço</h1>

        <div className="notice notice-warning">
          <strong>Isto exige confirmação por passkey.</strong>
          <br />
          Trocar o endereço de um contato redireciona todos os próximos envios para ele. É
          justamente o que alguém faria se tivesse acesso à sua conta — por isso pedimos
          confirmação, mesmo sendo você.
        </div>

        <div className="card">
          <div className="review-row">
            <span className="review-label">Contato</span>
            <span className="review-value">{editando.label}</span>
          </div>
          <div className="review-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <span className="review-label">Endereço atual</span>
            <span
              className="review-value"
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}
            >
              {editando.destination}
            </span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="novo">Novo endereço</label>
          <input
            id="novo"
            placeholder="lq1..."
            value={novoDestino}
            onChange={(e) => setNovoDestino(e.target.value)}
            autoFocus
          />
          <div style={{ marginTop: 8 }}>
            <QrScanButton onClick={() => setLendoQr(true)} />
          </div>
        </div>

        {error && <div className="notice notice-danger">{error}</div>}

        <button
          type="button"
          className="btn"
          disabled={busy || !novoDestino.trim()}
          onClick={trocarEndereco}
        >
          {busy ? 'Aguardando confirmação…' : 'Confirmar com passkey e alterar'}
        </button>
      </>
    );
  }

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Contatos</h1>

      {error && <div className="notice notice-danger">{error}</div>}

      <form onSubmit={adicionar}>
        <div className="field">
          <label htmlFor="label">Nome</label>
          <input
            id="label"
            placeholder="Ex.: Maria"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="destino">Endereço</label>
          <input
            id="destino"
            placeholder="lq1..."
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            <QrScanButton onClick={() => setLendoQr(true)} />
          </div>
        </div>
        <button type="submit" className="btn" disabled={busy || !label.trim() || !destino.trim()}>
          Adicionar contato
        </button>
      </form>

      <div className="section-title">Salvos</div>

      {loading ? (
        <div className="empty">Carregando…</div>
      ) : contatos.length === 0 ? (
        <div className="empty">Nenhum contato ainda.</div>
      ) : (
        <div className="card">
          {contatos.map((c) => (
            <div
              key={c.id}
              className="review-row"
              style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}
            >
              <span className="tx-title">{c.label}</span>
              {/* Endereço por inteiro, nunca abreviado: um ataque de
                  substituição mantém as pontas iguais e troca o meio. */}
              <span
                className="tx-meta"
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' }}
              >
                {c.destination}
              </span>
              <span className="tx-meta">
                {c.timesUsed === 0 ? 'nunca usado' : `usado ${c.timesUsed}×`}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: 13 }}
                  onClick={() => {
                    setEditando(c);
                    setNovoDestino('');
                    setError(null);
                  }}
                >
                  Alterar endereço
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: 13 }}
                  onClick={() => void remover(c)}
                >
                  Remover
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
