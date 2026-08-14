'use client';

/**
 * Enviar.
 *
 * Duas telas com caráter oposto, de propósito.
 *
 * O envio entre carteiras vai até o fim: revisar → confirmar identidade se a
 * política pedir → destravar o cofre → assinar no dispositivo → transmitir →
 * avisar o servidor. O ponto sem volta é a transmissão, e a tela deixa isso
 * explícito antes e depois.
 *
 * O envio por Pix não vai — e a tela diz por quê em vez de simular. Falta o
 * contrato de saque com um operador (endereço de depósito e endereço de taxa
 * por cotação); sem isso não há transação a montar. É a diferença entre "não
 * implementamos ainda" e "não temos com quem falar", e o usuário merece saber
 * qual das duas é.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { parseUserAmount, rescale } from '@depix/core/browser';
import type { SendStage } from '@depix/wallet';

import { ApiRequestError, type Contact, type PixKeyPreview, type SendReview, api } from '../../lib/api';
import { STAGE_LABEL, hasWallet, signAndSend } from '../../lib/device-wallet';
import { PasskeyCancelled, reauth } from '../../lib/passkey';
import { QrScanButton, QrScanner } from '../../components/QrScanner';

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

        {/* Interface honesta em vez de bonita: um botão "Enviar" aqui levaria
            a um erro, ou pior, a uma tela de sucesso sem lastro. */}
        <div className="notice notice-info">
          <strong>O envio por Pix ainda não pode ser concluído.</strong>
          <br />
          Para sacar, um operador de Pix precisa nos informar, a cada cotação, o endereço de
          depósito e o endereço de taxa da transação. Esse contrato depende de credencial
          aprovada, e não existe forma de contorná-lo — a transação simplesmente não teria para
          onde ir.
          <br />
          <br />
          Enquanto isso, o envio entre carteiras funciona normalmente.
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

// --- Envio entre carteiras ---------------------------------------------------

type Passo = 'form' | 'revisao' | 'assinando' | 'concluido';

function EnviarCarteira() {
  const [passo, setPasso] = useState<Passo>('form');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<SendReview | null>(null);
  const [pin, setPin] = useState('');
  const [stage, setStage] = useState<SendStage | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Motivo dado pela política quando ela pede confirmação de identidade. */
  const [precisaConfirmar, setPrecisaConfirmar] = useState<string | null>(null);
  const [contatos, setContatos] = useState<Contact[]>([]);
  const [lendoQr, setLendoQr] = useState(false);
  const [salvarComo, setSalvarComo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.contacts().then((r) => setContatos(r.contacts)).catch(() => setContatos([]));
  }, []);

  async function revisar(e: React.FormEvent) {
    e.preventDefault();
    if (!hasWallet()) {
      setError(
        'Nenhuma carteira neste dispositivo. Crie ou restaure a sua em Ajustes antes de enviar.',
      );
      return;
    }

    setBusy(true);
    setError(null);
    setPrecisaConfirmar(null);
    try {
      setReview(await api.prepareSend(amount, address));
      setPasso('revisao');
    } catch (err) {
      // `reauth_required` não é falha: é uma etapa a mais. Tratá-lo como erro
      // vermelho deixaria o usuário num beco, com um envio legítimo recusado
      // e nenhum caminho à frente.
      if (err instanceof ApiRequestError && err.code === 'reauth_required') {
        setPrecisaConfirmar(err.message);
      } else {
        setError(mensagemDe(err, 'Não foi possível preparar o envio'));
      }
    } finally {
      setBusy(false);
    }
  }

  /** A política pediu confirmação: faz a cerimônia e repete o preparo. */
  async function confirmarIdentidade() {
    setBusy(true);
    setError(null);
    try {
      await reauth();
      setReview(await api.prepareSend(amount, address));
      setPrecisaConfirmar(null);
      setPasso('revisao');
    } catch (err) {
      setError(
        err instanceof PasskeyCancelled
          ? 'Confirmação cancelada. O envio não foi feito.'
          : mensagemDe(err, 'Não foi possível confirmar sua identidade'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function assinarEEnviar(e: React.FormEvent) {
    e.preventDefault();
    if (!review) return;

    setBusy(true);
    setError(null);
    setPasso('assinando');

    try {
      // Quem assina não aceita o valor de quem não assina: refazemos a
      // conversão a partir do que o usuário digitou e conferimos contra o
      // número do servidor. Divergência aqui é anomalia grave — o servidor
      // não tem como assinar, mas poderia induzir o dispositivo a assinar
      // mais do que a tela mostrou.
      const esperado = rescale(parseUserAmount(amount, 'BRL'), 'DEPIX').amount;
      const doServidor = BigInt(review.amountUnits);
      if (esperado !== doServidor) {
        throw new Error(
          'O valor calculado pelo servidor não confere com o que você digitou. ' +
            'O envio foi interrompido por segurança.',
        );
      }

      const id = await signAndSend({
        pin,
        destinationAddress: review.destination,
        amount: doServidor,
        onStage: setStage,
      });
      setTxid(id);
      setPin('');

      // A partir daqui o dinheiro já andou. Falhar em avisar o servidor não
      // desfaz nada — por isso o erro vira aviso, não erro, e o txid continua
      // sendo mostrado ao usuário.
      try {
        await api.confirmBroadcast(review.transactionId, id);
      } catch {
        setAviso(
          'O envio foi transmitido, mas não conseguimos registrar isso no seu extrato agora. ' +
            'Ele aparecerá quando a conexão voltar — a transação já está na rede.',
        );
      }

      setPasso('concluido');
    } catch (err) {
      setError(mensagemDe(err, 'Não foi possível concluir o envio'));
      setPasso('revisao');
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  if (passo === 'concluido' && txid) {
    return (
      <>
        <div className="section-title">Enviado</div>
        <div className="card">
          <div className="review-row">
            <span className="review-label">Valor</span>
            <span className="review-value">{review?.amount}</span>
          </div>
          <div className="review-row">
            <span className="review-label">Para</span>
            <span className="review-value" style={{ fontSize: 12 }}>
              {review?.destination}
            </span>
          </div>
          <div className="review-row">
            <span className="review-label">Identificador</span>
            <span className="review-value" style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
              {txid}
            </span>
          </div>
        </div>

        {aviso && <div className="notice notice-warning">{aviso}</div>}

        <div className="notice notice-info">
          A transação está na rede e não pode ser cancelada. O saldo é atualizado assim que a
          Liquid confirmar — normalmente em cerca de um minuto.
        </div>

        {/* Oferecer salvar depois do envio, e não antes: é aqui que o usuário
            sabe que o endereço estava certo. */}
        {!contatos.some((c) => c.destination === review?.destination) && (
          <div className="card">
            <div className="field">
              <label htmlFor="salvar">Salvar este destino na agenda</label>
              <input
                id="salvar"
                placeholder="Ex.: Maria"
                value={salvarComo}
                onChange={(e) => setSalvarComo(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!salvarComo.trim() || busy}
              onClick={() => {
                setBusy(true);
                void api
                  .saveContact(salvarComo.trim(), review!.destination)
                  .then((c) => {
                    setContatos((atuais) => [...atuais, c]);
                    setSalvarComo('');
                  })
                  .catch(() => undefined)
                  .finally(() => setBusy(false));
              }}
            >
              Salvar contato
            </button>
          </div>
        )}

        <Link href="/" className="btn" style={{ display: 'block', textAlign: 'center' }}>
          Voltar ao início
        </Link>
      </>
    );
  }

  if (passo === 'assinando') {
    return (
      <>
        <div className="section-title">Enviando</div>
        <div className="card">
          <div className="review-row">
            <span className="review-label">{stage ? STAGE_LABEL[stage] : 'Preparando…'}</span>
          </div>
        </div>
        <div className="notice notice-warning">
          Não feche esta tela. A assinatura acontece no seu dispositivo.
        </div>
      </>
    );
  }

  if (passo === 'revisao' && review) {
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

        <form onSubmit={assinarEEnviar}>
          <div className="field">
            <label htmlFor="pin">PIN da carteira</label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Seu PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </div>

          {error && <div className="notice notice-danger">{error}</div>}

          <div className="notice notice-info">
            Nosso servidor não tem sua chave e não consegue assinar por você. Ao confirmar, a
            transação é montada, conferida e assinada aqui no seu dispositivo.
          </div>

          <button type="submit" className="btn" disabled={busy || pin.length === 0}>
            Confirmar e enviar
          </button>
        </form>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setReview(null);
            setPin('');
            setError(null);
            setPasso('form');
          }}
        >
          Voltar
        </button>
      </>
    );
  }

  if (lendoQr) {
    return (
      <QrScanner
        onScan={(lido) => {
          setLendoQr(false);
          if (lido.kind === 'liquid_address') {
            setAddress(lido.value);
            setError(null);
          } else {
            // Não preenche com o que não reconheceu: encher o campo de
            // destino com texto não conferido é pior do que não ler nada.
            setError(
              lido.kind === 'pix'
                ? 'Este é um QR de Pix, não um endereço de carteira. Use "Enviar Pix".'
                : 'Não reconheci este código como endereço Liquid.',
            );
          }
        }}
        onClose={() => setLendoQr(false)}
      />
    );
  }

  return (
    <form onSubmit={revisar}>
      {contatos.length > 0 && (
        <div className="field">
          <label htmlFor="contato">Contato salvo</label>
          <select
            id="contato"
            value=""
            onChange={(e) => {
              const escolhido = contatos.find((c) => c.id === e.target.value);
              if (escolhido) setAddress(escolhido.destination);
            }}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          >
            <option value="">Escolher da agenda…</option>
            {contatos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="dest">Endereço de destino</label>
        <input
          id="dest"
          placeholder="lq1..."
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoFocus
        />
        <div style={{ marginTop: 8 }}>
          <QrScanButton onClick={() => setLendoQr(true)} />
        </div>
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

      {/* Reautenticação não é erro: é uma etapa a mais, e a tela a trata
          assim — com um botão, não com uma mensagem vermelha e um beco. */}
      {precisaConfirmar && (
        <div className="notice notice-warning">
          <strong>Este envio precisa da sua confirmação.</strong>
          <br />
          {precisaConfirmar}
          <br />
          <br />
          <button type="button" className="btn" onClick={confirmarIdentidade} disabled={busy}>
            {busy ? 'Aguardando…' : 'Confirmar com passkey'}
          </button>
        </div>
      )}

      <button type="submit" className="btn" disabled={busy || !address || !amount}>
        {busy ? 'Calculando…' : 'Revisar envio'}
      </button>
    </form>
  );
}

function mensagemDe(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
