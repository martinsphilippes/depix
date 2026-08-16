/**
 * Um giro do worker, disparado pelas próprias operações.
 *
 * No plano gratuito da Vercel o cron roda uma vez por dia — o suficiente
 * para a varredura de conciliação, mas não para confirmar transações com a
 * agilidade que o usuário espera. Este módulo cobre a diferença: depois de
 * responder uma operação que enfileira trabalho (depósito criado, envio
 * transmitido, webhook recebido), a mesma função serverless esvazia as filas
 * antes de ser congelada, via `after()`.
 *
 * O que este atalho NÃO muda: só o worker conclui transação, e só depois de
 * ver confirmação real. Aqui roda exatamente o mesmo código de handler que o
 * cron e o worker contínuo usam — muda apenas o gatilho. A fila usa lease,
 * então um giro daqui convivendo com o cron (ou com um worker contínuo em
 * outra máquina) nunca processa o mesmo job duas vezes.
 *
 * A conciliação fica de fora de propósito: é varredura pesada de quota, tem
 * dona (o cron diário) e não deixa usuário esperando.
 */

interface Dependencias {
  db: import('@depix/firestore').Db;
  drenar: () => Promise<void>;
}

/**
 * Montagem cara (Firestore, config, handlers) feita uma vez por processo —
 * a Vercel reusa o processo entre requisições próximas, como já acontece com
 * o servidor Fastify na rota principal. O `db` fica aberto de propósito.
 */
let dependencias: Promise<Dependencias> | null = null;

async function obterDependencias(): Promise<Dependencias> {
  dependencias ??= (async () => {
    const { loadConfig } = await import('@depix/api/config');
    const { buildDepixProvider } = await import('@depix/api/server');
    const { createDb, createFirestore } = await import('@depix/firestore');
    const { EsploraLiquidProvider } = await import('@depix/providers');
    const { QUEUES, createConfirmationHandler, createWebhookHandler, drainQueue } = await import(
      '@depix/app'
    );

    const config = loadConfig();
    const db = createDb(
      createFirestore({
        projectId: config.firebase.projectId,
        ...(config.firebase.emulatorHost ? { emulatorHost: config.firebase.emulatorHost } : {}),
        ...(config.firebase.databaseId ? { databaseId: config.firebase.databaseId } : {}),
        ...(config.firebase.credentials ? { credentials: config.firebase.credentials } : {}),
      }),
    );

    const webhookHandler = createWebhookHandler(db, { provider: buildDepixProvider(config) });
    const confirmHandler = createConfirmationHandler(db, { liquid: new EsploraLiquidProvider() });

    return {
      db,
      // Teto curto: isto roda no tempo emprestado do `after()`, não numa
      // função dedicada. O que não couber fica para o próximo gatilho ou
      // para o cron — o lease garante que nada se perde.
      drenar: async () => {
        await drainQueue(db, {
          queue: QUEUES.webhook,
          handler: webhookHandler,
          workerId: 'vercel-after',
          budgetMs: 15_000,
        });
        await drainQueue(db, {
          queue: QUEUES.confirm,
          handler: confirmHandler,
          workerId: 'vercel-after',
          budgetMs: 15_000,
        });
      },
    };
  })();

  return dependencias;
}

let emAndamento: Promise<void> | null = null;

/**
 * Esvazia as filas uma vez. Chamadas concorrentes no mesmo processo colapsam
 * num giro só — duas operações em sequência não precisam de duas varreduras.
 * Nunca lança: o giro é oportunista, e falhar aqui não pode marcar erro numa
 * operação que já foi respondida com sucesso.
 */
export function processarFilas(): Promise<void> {
  emAndamento ??= (async () => {
    try {
      const { drenar } = await obterDependencias();
      await drenar();
    } catch (err) {
      console.error('giro oportunista do worker falhou', err);
    } finally {
      emAndamento = null;
    }
  })();

  return emAndamento;
}
