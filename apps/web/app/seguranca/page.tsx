'use client';

/**
 * Segurança da conta.
 *
 * Reúne os dois fatores num lugar só e mostra o estado de cada um. A tela tem
 * um trabalho didático além do funcional: deixar claro que **a senha da conta
 * e o PIN da carteira são coisas diferentes**.
 *
 * Confundi-los é o erro que custa caro. A senha prova quem você é para o
 * servidor e trafega pela rede a cada login. O PIN decifra a frase de
 * recuperação neste aparelho e nunca sai dele. Usar o mesmo valor nos dois
 * faz o segredo que trafega virar a chave do cofre — e um vazamento do lado
 * do servidor passaria a valer o dinheiro, não só a conta.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiRequestError, api } from '../../lib/api';
import { PasskeyCancelled, reauth, register as registrarPasskey, supported } from '../../lib/passkey';

export default function Seguranca() {
  const [metodos, setMetodos] = useState<{ password: boolean; passkeys: number } | null>(null);
  const [temSuportePasskey, setTemSuportePasskey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Troca de senha
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [novaConfirma, setNovaConfirma] = useState('');

  // Definir senha (conta que só tem passkey)
  const [identifier, setIdentifier] = useState('');

  useEffect(() => {
    setTemSuportePasskey(supported());
    api
      .authMethods()
      .then(setMetodos)
      .catch((err: Error) => setError(err.message));
  }, []);

  async function trocarSenha(e: React.FormEvent) {
    e.preventDefault();
    if (nova !== novaConfirma) {
      setError('As duas senhas novas não são iguais.');
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.changePassword(atual, nova);
      setOk('Senha alterada.');
      setAtual('');
      setNova('');
      setNovaConfirma('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível trocar a senha');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Definir senha numa conta que só tinha passkey.
   *
   * Exige confirmação recente. Sem isso, uma sessão roubada acrescentaria uma
   * senha conhecida pelo atacante a uma conta que só o dono acessava — e ele
   * passaria a entrar sem precisar do aparelho de ninguém.
   */
  async function definirSenha(e: React.FormEvent) {
    e.preventDefault();
    if (nova !== novaConfirma) {
      setError('As duas senhas não são iguais.');
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);

    const aplicar = () => api.setPassword(identifier.trim(), nova);

    try {
      try {
        await aplicar();
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'reauth_required') {
          await reauth();
          await aplicar();
        } else {
          throw err;
        }
      }
      setOk('Senha definida. Agora você pode entrar com senha também.');
      setNova('');
      setNovaConfirma('');
      setMetodos(await api.authMethods());
    } catch (err) {
      setError(
        err instanceof PasskeyCancelled
          ? 'Confirmação cancelada. A senha não foi definida.'
          : err instanceof Error
            ? err.message
            : 'Não foi possível definir a senha',
      );
    } finally {
      setBusy(false);
    }
  }

  async function cadastrarPasskey() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await registrarPasskey();
      setOk('Passkey cadastrada neste dispositivo.');
      setMetodos(await api.authMethods());
    } catch (err) {
      if (err instanceof PasskeyCancelled) setError(null);
      else setError(err instanceof Error ? err.message : 'Não foi possível cadastrar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link href="/ajustes" className="back">
        ← Voltar
      </Link>
      <h1>Segurança da conta</h1>

      <div className="card">
        <div className="review-row">
          <span className="review-label">Senha</span>
          <span className="review-value">{metodos?.password ? 'Cadastrada' : 'Não cadastrada'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Passkeys</span>
          <span className="review-value">
            {metodos ? (metodos.passkeys === 0 ? 'Nenhuma' : `${metodos.passkeys}`) : '—'}
          </span>
        </div>
      </div>

      {error && <div className="notice notice-danger">{error}</div>}
      {ok && <div className="notice notice-info">{ok}</div>}

      {/* O aviso que justifica a tela existir. */}
      <div className="notice notice-warning">
        <strong>A senha da conta não é o PIN da carteira.</strong>
        <br />
        A senha prova quem você é para nós, e viaja pela rede a cada login. O PIN decifra sua
        frase de recuperação <strong>neste aparelho</strong> e nunca sai dele. Use valores
        diferentes: se forem iguais, o segredo que trafega vira a chave do seu dinheiro.
      </div>

      {metodos?.password ? (
        <>
          <div className="section-title">Trocar senha</div>
          <form onSubmit={trocarSenha}>
            <div className="field">
              <label htmlFor="atual">Senha atual</label>
              <input
                id="atual"
                type="password"
                autoComplete="current-password"
                value={atual}
                onChange={(e) => setAtual(e.target.value)}
              />
              <div className="tx-meta" style={{ marginTop: 7 }}>
                Pedimos a atual mesmo com você logado: uma sessão roubada não deve conseguir
                trocar sua senha e te expulsar da própria conta.
              </div>
            </div>
            <div className="field">
              <label htmlFor="nova">Nova senha</label>
              <input
                id="nova"
                type="password"
                autoComplete="new-password"
                value={nova}
                onChange={(e) => setNova(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nova2">Repita a nova senha</label>
              <input
                id="nova2"
                type="password"
                autoComplete="new-password"
                value={novaConfirma}
                onChange={(e) => setNovaConfirma(e.target.value)}
              />
            </div>
            <button type="submit" className="btn" disabled={busy || !atual || !nova}>
              {busy ? 'Aguarde…' : 'Trocar senha'}
            </button>
          </form>
        </>
      ) : (
        <>
          <div className="section-title">Definir uma senha</div>
          <form onSubmit={definirSenha}>
            <div className="field">
              <label htmlFor="ident">E-mail ou nome de usuário</label>
              <input
                id="ident"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nova">Senha</label>
              <input
                id="nova"
                type="password"
                autoComplete="new-password"
                value={nova}
                onChange={(e) => setNova(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nova2">Repita a senha</label>
              <input
                id="nova2"
                type="password"
                autoComplete="new-password"
                value={novaConfirma}
                onChange={(e) => setNovaConfirma(e.target.value)}
              />
            </div>
            <div className="notice notice-info">
              Vamos pedir sua passkey para confirmar. Acrescentar uma senha é operação sensível:
              sem a confirmação, uma sessão roubada poderia cadastrar uma senha e passar a entrar
              sem o seu aparelho.
            </div>
            <button
              type="submit"
              className="btn"
              disabled={busy || !identifier.trim() || !nova}
            >
              {busy ? 'Aguarde…' : 'Definir senha'}
            </button>
          </form>
        </>
      )}

      {temSuportePasskey && (
        <>
          <div className="section-title">Passkey</div>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={cadastrarPasskey}>
            Cadastrar passkey neste dispositivo
          </button>
          <div className="notice notice-info">
            Uma passkey por aparelho que você usa. Ela resiste a phishing de um jeito que senha
            nenhuma resiste — e serve de reserva se você esquecer a senha.
          </div>
        </>
      )}
    </>
  );
}
