'use client';

/**
 * Receber.
 *
 * O endereço de recebimento é derivado **aqui**, da chave do próprio usuário
 * — nunca pedido ao servidor. A razão não é purismo: um servidor comprometido
 * que respondesse "seu endereço é X" desviaria todos os depósitos, e o
 * usuário só descobriria quando o dinheiro não chegasse. É o mesmo motivo
 * pelo qual assinamos no dispositivo.
 *
 * O QR sai do próprio LWK (`stringToQr`), então não há serviço externo
 * gerando imagem a partir do endereço nem dependência nova para auditar.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiRequestError, type DepositIntent, api } from '../../lib/api';
import { deviceAddress, hasWallet, qrDataUri } from '../../lib/device-wallet';

type Modo = 'escolha' | 'pix' | 'carteira';

export default function Receber() {
  const [modo, setModo] = useState<Modo>('escolha');
  const [temCarteira, setTemCarteira] = useState(true);

  useEffect(() => setTemCarteira(hasWallet()), []);

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Receber</h1>

      {!temCarteira ? (
        <div className="notice notice-warning">
          <strong>Este dispositivo ainda não tem sua carteira.</strong>
          <br />
          O endereço de recebimento é gerado a partir da sua chave, aqui no aparelho — sem
          carteira não há endereço para gerar.
          <br />
          <br />
          <Link href="/carteira" className="btn" style={{ display: 'inline-block' }}>
            Criar ou restaurar carteira
          </Link>
        </div>
      ) : (
        <>
          {modo === 'escolha' && <Escolha onSelect={setModo} />}
          {modo === 'pix' && <ReceberPix />}
          {modo === 'carteira' && <ReceberCarteira />}
        </>
      )}
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

/** Imagem do QR. `image-rendering: pixelated` evita o borrão do upscale. */
function Qr({ uri, label }: { uri: string; label: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={uri}
      alt={label}
      style={{
        width: '100%',
        maxWidth: 260,
        display: 'block',
        margin: '0 auto',
        imageRendering: 'pixelated',
        border: '16px solid #fff',
        borderRadius: 8,
        background: '#fff',
      }}
    />
  );
}

function ReceberPix() {
  const [amount, setAmount] = useState('');
  const [intent, setIntent] = useState<DepositIntent | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function gerar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // O destino é a carteira do próprio usuário, derivada aqui. O usuário
      // não precisa colar endereço nenhum — e não deveria mesmo: pedir isso
      // era um convite a colar o endereço errado.
      const destino = await deviceAddress({ fresh: true });
      const criado = await api.createDeposit(amount, destino);
      setIntent(criado);
      setQr(await qrDataUri(criado.qrCopyPaste));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : (err as Error).message);
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

        {qr && <Qr uri={qr} label="QR Code do Pix" />}

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

      <div className="notice notice-info">
        O valor vai direto para a sua carteira, num endereço gerado aqui no seu dispositivo. Nós
        não guardamos o seu dinheiro e não escolhemos para onde ele vai.
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      <button type="submit" className="btn" disabled={busy || !amount}>
        {busy ? 'Gerando…' : 'Gerar cobrança'}
      </button>
    </form>
  );
}

function ReceberCarteira() {
  const [address, setAddress] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const a = await deviceAddress();
        setAddress(a);
        setQr(await qrDataUri(a));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  async function novoEndereco() {
    const a = await deviceAddress({ fresh: true });
    setAddress(a);
    setQr(await qrDataUri(a));
  }

  return (
    <>
      <div className="notice notice-warning">
        <strong>Atenção à rede.</strong> Envie apenas DePix pela rede Liquid para este endereço.
        Valores enviados por outra rede não podem ser recuperados.
      </div>

      {error && <div className="notice notice-danger">{error}</div>}

      {qr && <Qr uri={qr} label="QR Code do endereço da carteira" />}

      {address && (
        <>
          <div className="section-title">Seu endereço</div>
          <div className="copy-box">{address}</div>

          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copiado ✓' : 'Copiar endereço'}
          </button>

          {/* Endereço novo a cada recebimento não protege o dinheiro; protege
              a privacidade, evitando que pagamentos distintos fiquem ligados
              entre si na cadeia. */}
          <button type="button" className="btn btn-secondary" onClick={novoEndereco}>
            Gerar outro endereço
          </button>
        </>
      )}

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
    </>
  );
}
