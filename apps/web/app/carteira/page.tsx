'use client';

/**
 * Criar ou restaurar a carteira.
 *
 * Esta tela é onde a autocustódia deixa de ser conceito e vira obrigação do
 * usuário. Duas decisões de desenho vêm daí:
 *
 * **O backup é passo obrigatório, não sugestão.** As 12 palavras aparecem uma
 * vez e o botão de avançar exige que o usuário digite três delas, escolhidas
 * ao acaso. Um checkbox "anotei minha frase" seria mais rápido e treinaria o
 * usuário a mentir — e a mentira só cobra o preço quando ele troca de celular.
 *
 * **O descriptor vai ao servidor; a frase, não.** O que é enviado permite ver
 * saldo e conciliar, e é insuficiente para gastar. `deriveIdentity` roda aqui
 * e devolve só a parte pública — não existe caminho neste arquivo em que a
 * frase saia do dispositivo.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { MIN_PIN_LENGTH } from '@depix/wallet/vault';

import { api } from '../../lib/api';
import {
  type CreatedWallet,
  NETWORK,
  createWallet,
  hasWallet,
  identityOf,
  persistWallet,
} from '../../lib/device-wallet';

type Passo = 'escolha' | 'frase' | 'conferencia' | 'restaurar' | 'pin' | 'pronto';

export default function Carteira() {
  const router = useRouter();
  const [passo, setPasso] = useState<Passo>(() => 'escolha');
  const [wallet, setWallet] = useState<CreatedWallet | null>(null);
  const [frase, setFrase] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirma, setPinConfirma] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Em `useEffect` e não no corpo do render: `localStorage` não existe no
  // servidor, e ler durante o render daria hidratação divergente.
  const [jaTem, setJaTem] = useState(false);
  useEffect(() => setJaTem(hasWallet()), []);

  async function comecarCriacao() {
    setError(null);
    setBusy(true);
    try {
      setWallet(await createWallet());
      setPasso('frase');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gerar a carteira');
    } finally {
      setBusy(false);
    }
  }

  function seguirParaRestauracao() {
    setError(null);
    setPasso('restaurar');
  }

  async function conferirFrase(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setWallet(await identityOf(frase.trim().toLowerCase().replace(/\s+/g, ' ')));
      setPasso('pin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Frase inválida');
    } finally {
      setBusy(false);
    }
  }

  async function finalizar(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) return;

    if (pin !== pinConfirma) {
      setError('Os dois PINs não são iguais.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await persistWallet(wallet, pin);
      // Só o descriptor watch-only sai do dispositivo.
      await api.registerWallet(wallet.ctDescriptor, NETWORK);
      await api.confirmBackup();

      // A frase sai do estado assim que deixa de ser necessária.
      setWallet(null);
      setFrase('');
      setPin('');
      setPinConfirma('');
      setPasso('pronto');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar a carteira');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Sua carteira</h1>

      {passo === 'escolha' && (
        <>
          {jaTem && (
            <div className="notice notice-warning">
              <strong>Já existe uma carteira neste dispositivo.</strong>
              <br />
              Criar ou restaurar outra substitui a atual aqui. Se você não tiver a frase de
              recuperação da carteira atual anotada, o acesso a ela se perde.
            </div>
          )}

          <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
            <button
              type="button"
              className="action"
              onClick={comecarCriacao}
              disabled={busy}
            >
              <span className="action-icon" aria-hidden>
                +
              </span>
              Criar carteira nova
              <span className="action-hint">Gera 12 palavras neste dispositivo</span>
            </button>

            <button type="button" className="action" onClick={seguirParaRestauracao}>
              <span className="action-icon" aria-hidden>
                ↺
              </span>
              Restaurar carteira
              <span className="action-hint">Já tenho minha frase de recuperação</span>
            </button>
          </div>

          <div className="notice notice-info">
            As chaves são geradas e ficam no seu dispositivo. Nós nunca as vemos — o que significa
            que nós também não conseguimos recuperá-las por você.
          </div>
        </>
      )}

      {passo === 'frase' && wallet && (
        <MostrarFrase
          mnemonic={wallet.mnemonic}
          onContinuar={() => setPasso('conferencia')}
        />
      )}

      {passo === 'conferencia' && wallet && (
        <ConferirFrase
          mnemonic={wallet.mnemonic}
          onOk={() => setPasso('pin')}
          onVoltar={() => setPasso('frase')}
        />
      )}

      {passo === 'restaurar' && (
        <form onSubmit={conferirFrase}>
          <div className="field">
            <label htmlFor="frase">Sua frase de recuperação</label>
            <textarea
              id="frase"
              rows={3}
              placeholder="as 12 palavras, separadas por espaço"
              value={frase}
              onChange={(e) => setFrase(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              style={{
                width: '100%',
                padding: 12,
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                font: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {error && <div className="notice notice-danger">{error}</div>}

          <button type="submit" className="btn" disabled={busy || !frase.trim()}>
            {busy ? 'Verificando…' : 'Continuar'}
          </button>
        </form>
      )}

      {passo === 'pin' && (
        <form onSubmit={finalizar}>
          <div className="section-title">Crie um PIN</div>

          <div className="notice notice-info">
            O PIN protege sua frase neste dispositivo e é pedido a cada envio. Ele não é enviado a
            lugar nenhum — sem ele, nem nós nem ninguém abre esta carteira aqui. Esquecer o PIN
            não é problema se você tiver a frase de recuperação; sem os dois, o acesso se perde.
          </div>

          <div className="field">
            <label htmlFor="pin">PIN (mínimo de {MIN_PIN_LENGTH} caracteres)</label>
            <input
              id="pin"
              type="password"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="pin2">Repita o PIN</label>
            <input
              id="pin2"
              type="password"
              autoComplete="new-password"
              value={pinConfirma}
              onChange={(e) => setPinConfirma(e.target.value)}
            />
          </div>

          {error && <div className="notice notice-danger">{error}</div>}

          <button
            type="submit"
            className="btn"
            disabled={busy || pin.length < MIN_PIN_LENGTH || !pinConfirma}
          >
            {busy ? 'Salvando…' : 'Concluir'}
          </button>
        </form>
      )}

      {passo === 'pronto' && (
        <>
          <div className="notice notice-info">
            <strong>Carteira pronta.</strong>
            <br />
            Você já pode receber e enviar.
          </div>
          <button type="button" className="btn" onClick={() => router.push('/')}>
            Ir para o início
          </button>
        </>
      )}
    </>
  );
}

function MostrarFrase({
  mnemonic,
  onContinuar,
}: {
  mnemonic: string;
  onContinuar: () => void;
}) {
  const palavras = mnemonic.split(' ');

  return (
    <>
      <div className="notice notice-warning">
        <strong>Anote estas 12 palavras, na ordem, num lugar seguro.</strong>
        <br />
        Elas são a única forma de recuperar seu dinheiro se você perder este dispositivo. Nunca as
        digite em outro site, nunca as fotografe num aparelho conectado, e nunca as envie a
        ninguém — nem a nós. Quem pede sua frase está tentando roubar você.
      </div>

      <div className="card">
        <ol
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
            margin: 0,
            paddingLeft: 24,
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {palavras.map((palavra, i) => (
            <li key={`${i}-${palavra}`} style={{ fontSize: 14 }}>
              {palavra}
            </li>
          ))}
        </ol>
      </div>

      <button type="button" className="btn" onClick={onContinuar}>
        Anotei minha frase
      </button>
    </>
  );
}

/**
 * Confere três palavras sorteadas.
 *
 * Não é burocracia: é a diferença entre o usuário ter anotado e o usuário
 * achar que anotou. O custo de descobrir isso agora é um minuto; o de
 * descobrir depois é o dinheiro.
 */
function ConferirFrase({
  mnemonic,
  onOk,
  onVoltar,
}: {
  mnemonic: string;
  onOk: () => void;
  onVoltar: () => void;
}) {
  const palavras = useMemo(() => mnemonic.split(' '), [mnemonic]);
  const indices = useMemo(() => sortearIndices(palavras.length, 3), [palavras.length]);
  const [respostas, setRespostas] = useState<string[]>(['', '', '']);
  const [error, setError] = useState<string | null>(null);

  function verificar(e: React.FormEvent) {
    e.preventDefault();
    const certo = indices.every(
      (idx, i) => respostas[i]?.trim().toLowerCase() === palavras[idx],
    );
    if (!certo) {
      setError('Alguma palavra não confere. Volte e confira sua anotação.');
      return;
    }
    onOk();
  }

  return (
    <form onSubmit={verificar}>
      <div className="section-title">Confirme sua anotação</div>

      {indices.map((idx, i) => (
        <div className="field" key={idx}>
          <label htmlFor={`p${idx}`}>Palavra número {idx + 1}</label>
          <input
            id={`p${idx}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={respostas[i] ?? ''}
            onChange={(e) => {
              const next = [...respostas];
              next[i] = e.target.value;
              setRespostas(next);
              setError(null);
            }}
            {...(i === 0 ? { autoFocus: true } : {})}
          />
        </div>
      ))}

      {error && <div className="notice notice-danger">{error}</div>}

      <button type="submit" className="btn">
        Confirmar
      </button>
      <button type="button" className="btn btn-secondary" onClick={onVoltar}>
        Ver a frase de novo
      </button>
    </form>
  );
}

/** Sorteio sem repetição, com `crypto` — `Math.random` não tem por que estar aqui. */
function sortearIndices(total: number, quantos: number): number[] {
  const escolhidos = new Set<number>();
  const buf = new Uint32Array(1);
  while (escolhidos.size < quantos) {
    crypto.getRandomValues(buf);
    escolhidos.add(buf[0]! % total);
  }
  return [...escolhidos].sort((a, b) => a - b);
}
