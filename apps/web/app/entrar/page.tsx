'use client';

/**
 * Entrar.
 *
 * Dois caminhos, lado a lado: **senha** e **passkey**. Não é indecisão —
 * cada um resolve um problema que o outro não resolve.
 *
 * A senha é o que todo mundo já sabe usar, funciona em qualquer navegador e
 * não depende de o aparelho ter biometria. A passkey é mais forte de um jeito
 * que senha nenhuma alcança: a assinatura é amarrada ao domínio pelo
 * navegador, então um site clonado não consegue reaproveitá-la. Nenhuma senha,
 * por mais longa, resiste a alguém digitando-a no site errado.
 *
 * Por isso a tela oferece os dois e sugere cadastrar a passkey depois — sem
 * obrigar, e sem esconder que a senha é o elo mais fraco dos dois.
 *
 * O que **não** pedimos continua valendo: nenhum nome, CPF, telefone ou
 * documento. Um e-mail, se o usuário quiser usar e-mail; ou só um apelido.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiRequestError, api } from '../../lib/api';
import { PasskeyCancelled, login as loginPasskey, register as registrarPasskey, supported } from '../../lib/passkey';

type Aba = 'entrar' | 'criar';

export default function Entrar() {
  const router = useRouter();
  const [aba, setAba] = useState<Aba>('entrar');
  const [identifier, setIdentifier] = useState('');
  const [senha, setSenha] = useState('');
  const [senhaConfirma, setSenhaConfirma] = useState('');
  const [temPasskey, setTemPasskey] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setTemPasskey(supported()), []);

  async function comSenha(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (aba === 'criar') {
        if (senha !== senhaConfirma) {
          setError('As duas senhas não são iguais.');
          return;
        }
        await api.registerWithPassword(identifier.trim(), senha);
        router.push('/carteira');
      } else {
        await api.loginWithPassword(identifier.trim(), senha);
        router.push('/');
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível continuar');
    } finally {
      setBusy(false);
      setSenha('');
      setSenhaConfirma('');
    }
  }

  async function comPasskey(acao: 'entrar' | 'criar') {
    setBusy(true);
    setError(null);
    try {
      if (acao === 'criar') {
        const r = await registrarPasskey();
        if (r.warning) setAviso(r.warning);
        router.push('/carteira');
      } else {
        await loginPasskey();
        router.push('/');
      }
    } catch (err) {
      // Cancelar não é falhar: nada aconteceu, e a tela não deve gritar.
      if (err instanceof PasskeyCancelled) setError(null);
      else setError(err instanceof Error ? err.message : 'Não foi possível continuar');
    } finally {
      setBusy(false);
    }
  }

  const criando = aba === 'criar';

  return (
    <>
      <h1>Carteira</h1>

      <div className="actions" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 4 }}>
        <button
          type="button"
          className="action"
          data-active={!criando}
          style={{ padding: 12, opacity: criando ? 0.55 : 1 }}
          onClick={() => {
            setAba('entrar');
            setError(null);
          }}
        >
          Entrar
        </button>
        <button
          type="button"
          className="action"
          data-active={criando}
          style={{ padding: 12, opacity: criando ? 1 : 0.55 }}
          onClick={() => {
            setAba('criar');
            setError(null);
          }}
        >
          Criar conta
        </button>
      </div>

      <form onSubmit={comSenha}>
        <div className="field">
          <label htmlFor="identifier">E-mail ou nome de usuário</label>
          <input
            id="identifier"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="voce@exemplo.com"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoFocus
          />
          {criando && (
            <div className="tx-meta" style={{ marginTop: 7 }}>
              Pode ser só um apelido. Não pedimos nome, CPF nem telefone.
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="senha">Senha</label>
          <input
            id="senha"
            type="password"
            autoComplete={criando ? 'new-password' : 'current-password'}
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
          {criando && (
            <div className="tx-meta" style={{ marginTop: 7 }}>
              Pelo menos 12 caracteres. Uma frase que só você saberia vale mais que símbolos
              embaralhados.
            </div>
          )}
        </div>

        {criando && (
          <div className="field">
            <label htmlFor="senha2">Repita a senha</label>
            <input
              id="senha2"
              type="password"
              autoComplete="new-password"
              value={senhaConfirma}
              onChange={(e) => setSenhaConfirma(e.target.value)}
            />
          </div>
        )}

        {error && <div className="notice notice-danger">{error}</div>}

        <button
          type="submit"
          className="btn"
          disabled={busy || !identifier.trim() || !senha}
        >
          {busy ? 'Aguarde…' : criando ? 'Criar conta' : 'Entrar'}
        </button>
      </form>

      {temPasskey && (
        <>
          <div className="section-title">ou sem senha</div>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void comPasskey(criando ? 'criar' : 'entrar')}
          >
            {criando ? 'Criar conta com passkey' : 'Entrar com passkey'}
          </button>

          <div className="notice notice-info">
            <strong>A passkey é mais segura que a senha.</strong> Ela usa a biometria ou o PIN do
            seu aparelho e fica presa a este site — um site clonado não consegue usá-la. Senha
            nenhuma resiste a ser digitada no lugar errado.
            {!criando && ' Você pode cadastrar uma depois, em Ajustes.'}
          </div>
        </>
      )}

      {aviso && <div className="notice notice-warning">{aviso}</div>}

      {criando && (
        <div className="notice notice-info">
          Não coletamos dados pessoais. Em troca, guarde bem seus dados de acesso: sem e-mail
          verificado, a recuperação de conta é limitada. Seu <strong>dinheiro</strong> não depende
          disso — a carteira tem frase de recuperação própria.
        </div>
      )}

      <Link href="/" className="back" style={{ marginTop: 24, display: 'inline-block' }}>
        ← Voltar
      </Link>
    </>
  );
}
