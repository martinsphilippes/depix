'use client';

/**
 * Entrar.
 *
 * A tela mais curta do app, e de propósito: não há campo de e-mail, de senha,
 * de telefone nem de nome. Criar conta é um clique e uma biometria.
 *
 * Isso não é minimalismo estético. Não coletar identidade é requisito (§18):
 * não temos KYC próprio, não mantemos base de dados pessoais, e a conta é
 * pseudônima. Um campo de e-mail aqui criaria exatamente o cadastro que a
 * arquitetura evita — e, de quebra, daria ao phishing algo com que trabalhar.
 *
 * A contrapartida é dita ao usuário na própria tela, não escondida nos
 * termos: sem e-mail não existe "esqueci minha senha", e perder todas as
 * passkeys é perder a conta. O dinheiro é separado desse risco pela frase de
 * recuperação da carteira.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PasskeyCancelled, login, register, supported } from '../../lib/passkey';

export default function Entrar() {
  const router = useRouter();
  const [temSuporte, setTemSuporte] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setTemSuporte(supported()), []);

  async function executar(acao: () => Promise<unknown>, destino: string) {
    setBusy(true);
    setError(null);
    try {
      await acao();
      router.push(destino);
    } catch (err) {
      if (err instanceof PasskeyCancelled) {
        // Cancelar não é falhar. Nada aconteceu, e a tela não deve gritar.
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Não foi possível continuar');
      }
    } finally {
      setBusy(false);
    }
  }

  async function criarConta() {
    await executar(async () => {
      const r = await register();
      if (r.warning) setAviso(r.warning);
    }, '/carteira');
  }

  return (
    <>
      <h1>Carteira</h1>

      {!temSuporte && (
        <div className="notice notice-danger">
          Este navegador não suporta passkey. Como não usamos senha, não há outra forma de entrar
          — atualize o navegador ou use outro dispositivo.
        </div>
      )}

      <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
        <button
          type="button"
          className="action"
          disabled={busy || !temSuporte}
          onClick={() => executar(login, '/')}
        >
          <span className="action-icon" aria-hidden>
            →
          </span>
          Entrar
          <span className="action-hint">Com a passkey deste dispositivo</span>
        </button>

        <button type="button" className="action" disabled={busy || !temSuporte} onClick={criarConta}>
          <span className="action-icon" aria-hidden>
            +
          </span>
          Criar conta
          <span className="action-hint">Sem e-mail, sem senha, sem cadastro</span>
        </button>
      </div>

      {error && <div className="notice notice-danger">{error}</div>}
      {aviso && <div className="notice notice-warning">{aviso}</div>}

      <div className="notice notice-info">
        Não pedimos e-mail nem telefone — sua conta é anônima para nós. Em troca, não existe
        recuperação por e-mail: se você perder todas as suas passkeys, perde a conta. Seu dinheiro
        não depende disso, porque a carteira tem frase de recuperação própria.
      </div>

      <Link href="/" className="back" style={{ marginTop: 24, display: 'inline-block' }}>
        ← Voltar
      </Link>
    </>
  );
}
