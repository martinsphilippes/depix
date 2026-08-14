'use client';

/**
 * Painel administrativo (§24-25).
 *
 * Três coisas que este painel deliberadamente **não** faz, e vale mais
 * registrar do que as que faz:
 *
 * **Não mostra dado pessoal.** Não por política de acesso — porque não
 * existe: não coletamos identidade (§18). O que aparece é identificador
 * opaco, saldo e estado. Quem procurar nome ou CPF aqui não vai achar, e é
 * assim que o §18 se manifesta na prática.
 *
 * **Não corrige saldo.** Ajuste é lançamento no ledger, com contrapartida e
 * motivo. Um botão de "corrigir saldo" seria crédito sem lastro com outro
 * nome, e é exatamente o que os requisitos §43 proíbem.
 *
 * **Não resolve divergência sozinho.** Fechar um achado exige escrever o que
 * foi verificado. "Resolvido" sem explicação numa trilha financeira é
 * indistinguível de "alguém apertou o botão para a lista parar de incomodar".
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiRequestError, api } from '../../lib/api';

type Reconciliacao = Awaited<ReturnType<typeof api.adminReconciliation>>;

export default function Admin() {
  const [role, setRole] = useState<'operator' | 'auditor' | null>(null);
  const [negado, setNegado] = useState(false);
  const [dados, setDados] = useState<Reconciliacao | null>(null);
  const [notas, setNotas] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminMe()
      .then((me) => {
        setRole(me.role);
        return api.adminReconciliation().then(setDados);
      })
      .catch((err: Error) => {
        if (err instanceof ApiRequestError && err.status === 403) setNegado(true);
        else setError(err.message);
      });
  }, []);

  async function rodarAgora() {
    setBusy(true);
    setError(null);
    try {
      await api.adminRunReconciliation();
      setDados(await api.adminReconciliation());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolver(id: string) {
    const nota = (notas[id] ?? '').trim();
    if (!nota) return;
    setBusy(true);
    try {
      await api.adminResolveFinding(id, nota);
      setDados(await api.adminReconciliation());
      setNotas((n) => ({ ...n, [id]: '' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (negado) {
    return (
      <>
        <Link href="/" className="back">
          ← Voltar
        </Link>
        <h1>Painel</h1>
        <div className="notice notice-warning">
          Esta área é restrita. Se você deveria ter acesso, ele é concedido por script de operação
          — não existe rota para se promover a administrador, e isso é de propósito.
        </div>
      </>
    );
  }

  return (
    <>
      <Link href="/" className="back">
        ← Voltar
      </Link>
      <h1>Painel</h1>

      {role && (
        <div className="notice notice-info">
          Acesso: <strong>{role === 'operator' ? 'operador' : 'auditoria'}</strong>.
          {role === 'auditor' && ' Este perfil consulta, não age.'}
        </div>
      )}

      {error && <div className="notice notice-danger">{error}</div>}

      <div className="section-title">Conciliação</div>

      <div className="notice notice-info">
        A conciliação recomputa cada saldo a partir dos lançamentos. Como o Firestore não tem
        gatilho que impeça a divergência, esta verificação <strong>é</strong> a garantia de que o
        saldo vem do ledger — e não uma conferência opcional.
      </div>

      {role === 'operator' && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={rodarAgora}>
          {busy ? 'Rodando…' : 'Rodar conciliação agora'}
        </button>
      )}

      {!dados ? (
        <div className="empty">Carregando…</div>
      ) : (
        <>
          <div className="section-title">Divergências abertas</div>
          {dados.openFindings.length === 0 ? (
            <div className="empty">Nenhuma divergência aberta.</div>
          ) : (
            dados.openFindings.map((f) => (
              <div className="card" key={f.id}>
                <div className="review-row">
                  <span className="review-label">Tipo</span>
                  <span className="review-value">{f.kind}</span>
                </div>
                <div className="review-row">
                  <span className="review-label">Esperado</span>
                  <span className="review-value" style={{ fontSize: 11 }}>
                    {JSON.stringify(f.expected)}
                  </span>
                </div>
                <div className="review-row">
                  <span className="review-label">Observado</span>
                  <span className="review-value" style={{ fontSize: 11 }}>
                    {JSON.stringify(f.observed)}
                  </span>
                </div>
                <div className="review-row">
                  <span className="review-label">Quando</span>
                  <span className="review-value">
                    {new Date(f.createdAt).toLocaleString('pt-BR')}
                  </span>
                </div>

                {role === 'operator' && (
                  <>
                    <div className="field" style={{ marginTop: 12 }}>
                      <label htmlFor={`nota-${f.id}`}>O que foi verificado</label>
                      <input
                        id={`nota-${f.id}`}
                        placeholder="Obrigatório — vai para a trilha de auditoria"
                        value={notas[f.id] ?? ''}
                        onChange={(e) => setNotas((n) => ({ ...n, [f.id]: e.target.value }))}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy || !(notas[f.id] ?? '').trim()}
                      onClick={() => void resolver(f.id)}
                    >
                      Fechar divergência
                    </button>
                  </>
                )}
              </div>
            ))
          )}

          <div className="section-title">Últimas rodadas</div>
          <div className="card">
            {dados.runs.length === 0 ? (
              <div className="empty">Nenhuma rodada registrada.</div>
            ) : (
              dados.runs.map((r) => (
                <div className="review-row" key={r.id}>
                  <span className="review-label">
                    {new Date(r.startedAt).toLocaleString('pt-BR')} · {r.trigger}
                  </span>
                  <span
                    className="review-value"
                    style={{
                      color:
                        r.status === 'failed'
                          ? 'var(--danger, #c00)'
                          : Object.keys(r.findings).length > 0
                            ? 'var(--warning, #a60)'
                            : 'var(--accent-strong)',
                    }}
                  >
                    {r.status === 'failed'
                      ? 'falhou'
                      : Object.keys(r.findings).length === 0
                        ? `${r.accountsChecked} contas · ok`
                        : JSON.stringify(r.findings)}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Uma rodada que falha é ela própria um achado: um conciliador
              quebrado é indistinguível, de fora, de um sistema conciliado. */}
          {dados.runs.some((r) => r.status === 'failed') && (
            <div className="notice notice-danger">
              Alguma rodada de conciliação <strong>falhou</strong>. Enquanto isso não for
              resolvido, não há como afirmar que os saldos conferem — um conciliador quebrado
              parece, de fora, um sistema conciliado.
            </div>
          )}
        </>
      )}
    </>
  );
}
