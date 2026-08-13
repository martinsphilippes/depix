/**
 * Camada fina sobre o driver de banco.
 *
 * Existe por um motivo prático: as migrações e a suíte de testes precisam
 * rodar tanto contra um PostgreSQL real (produção, CI) quanto contra PGlite
 * (Postgres compilado para WASM, in-process) — que é o que permite testar
 * as invariantes do ledger sem subir servidor.
 *
 * ⚠️ Limite conhecido do PGlite: sessão única. Contenção real de
 * `SELECT ... FOR UPDATE` entre duas conexões não é observável nele. O teste
 * de gasto duplo concorrente exige Postgres de verdade e está separado em
 * `test/concurrency.pg.test.ts`, guardado por TEST_DATABASE_URL.
 */

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /**
   * Executa um script com múltiplos comandos (arquivos de migração).
   *
   * Separado de `query` porque o protocolo estendido — o que aceita
   * parâmetros — permite apenas um comando por chamada. `exec` nunca
   * recebe parâmetros, e por isso nunca deve receber entrada de usuário:
   * é para SQL estático do repositório.
   */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Executa `fn` dentro de uma transação. Faz COMMIT no sucesso e ROLLBACK
   * em qualquer exceção — inclusive nas levantadas pelos triggers de
   * invariante do ledger.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Adapta um Pool do driver `pg`. */
export function fromPgPool(pool: {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<{
    query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
    release: () => void;
  }>;
  end: () => Promise<void>;
}): Db {
  return {
    async query<R>(sql: string, params: readonly unknown[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(sql: string) {
      // Sem parâmetros → protocolo simples, que aceita múltiplos comandos.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          async query<R>(sql: string, params: readonly unknown[] = []) {
            const r = await client.query(sql, params);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Adapta uma instância de PGlite (usada em teste). */
export function fromPGlite(pg: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
}): Db {
  const run = async <R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> => {
    const r = await pg.query(sql, [...params]);
    return { rows: r.rows as R[], rowCount: r.rows.length };
  };

  const exec = async (sql: string): Promise<void> => {
    await pg.exec(sql);
  };

  return {
    query: run,
    exec,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec('BEGIN');
      try {
        const result = await fn({ query: run, exec });
        await pg.exec('COMMIT');
        return result;
      } catch (err) {
        await pg.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    async close() {
      await pg.close();
    },
  };
}
