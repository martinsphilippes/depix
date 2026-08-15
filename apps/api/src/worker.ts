/**
 * Processo do worker.
 *
 * Roda separado da API, no mesmo código-base. Não é serverless de propósito:
 * acompanhar confirmações on-chain é trabalho longo e contínuo, e a seção 36
 * dos requisitos é explícita sobre não forçar serverless onde ele não cabe.
 *
 *   npm run worker --workspace=@depix/api
 *
 * Passa pelo mesmo gate de ambiente da API — inclusive a recusa de apontar
 * para o Firestore real fora de produção sem confirmação explícita.
 */

import { createDb, createFirestore } from '@depix/firestore';
import { EsploraLiquidProvider } from '@depix/providers';
import {
  QUEUES,
  createConfirmationHandler,
  createWebhookHandler,
  runReconciliation,
  startWorker,
  type WorkerHandle,
} from '@depix/app';

import { loadConfig, startupBanner } from './config.ts';
import { buildDepixProvider } from './server.ts';

export async function startWorkers(): Promise<{ stop: () => Promise<void> }> {
  const config = loadConfig();

  const fs = createFirestore({
    projectId: config.firebase.projectId,
    ...(config.firebase.emulatorHost ? { emulatorHost: config.firebase.emulatorHost } : {}),
    ...(config.firebase.databaseId ? { databaseId: config.firebase.databaseId } : {}),
    ...(config.firebase.credentials ? { credentials: config.firebase.credentials } : {}),
  });
  const db = createDb(fs);

  const depixProvider = buildDepixProvider(config);
  const liquid = new EsploraLiquidProvider();

  const workerId = `${process.env['HOSTNAME'] ?? 'worker'}-${process.pid}`;
  const log = (msg: string): void => console.log(`[worker ${workerId}] ${msg}`);

  log(startupBanner(config));

  const handles: WorkerHandle[] = [
    startWorker(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider: depixProvider }),
      workerId: `${workerId}:webhook`,
      pollIntervalMs: 2_000,
      onError: (err) => log(`erro na fila de webhook: ${describe(err)}`),
    }),
    startWorker(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
      workerId: `${workerId}:confirm`,
      // Bloco da Liquid é de ~1 minuto; não há ganho em consultar mais.
      pollIntervalMs: 10_000,
      onError: (err) => log(`erro na fila de confirmação: ${describe(err)}`),
    }),
  ];

  log(`filas ativas: ${QUEUES.webhook}, ${QUEUES.confirm}`);

  // --- Conciliação periódica (§14) -------------------------------------------
  //
  // Não é fila: não há job a enfileirar, é uma varredura no relógio. E não é
  // conferência opcional — com o Firestore, a conciliação **é** o mecanismo
  // que detecta escrita feita por fora do ledger, porque não há trigger que a
  // impeça. Uma conciliação que não roda transforma "o saldo vem do ledger"
  // de garantia em esperança.
  const reconcileEvery = Number(process.env['RECONCILE_INTERVAL_MS'] ?? 15 * 60 * 1000);
  let reconciling = false;

  const reconcileTimer = setInterval(() => {
    // Guarda contra sobreposição: uma rodada lenta não deve disparar a
    // seguinte por cima dela.
    if (reconciling) return;
    reconciling = true;

    void runReconciliation(db, { trigger: 'scheduled' })
      .then((r) => {
        // Registra também quando está tudo certo: saber que a conciliação
        // rodou e não achou nada é diferente de não ter notícia dela.
        log(
          r.clean
            ? `conciliação ${r.runId}: ${r.accountsChecked} contas, sem divergência`
            : `conciliação ${r.runId}: DIVERGÊNCIAS ${JSON.stringify(r.findings)}`,
        );
      })
      .catch((err: unknown) => log(`falha na conciliação: ${describe(err)}`))
      .finally(() => {
        reconciling = false;
      });
  }, reconcileEvery);

  // Não segura o processo vivo só por causa do timer.
  reconcileTimer.unref();
  log(`conciliação a cada ${Math.round(reconcileEvery / 1000)}s`);

  return {
    async stop() {
      log('encerrando…');
      clearInterval(reconcileTimer);
      await Promise.all(handles.map((h) => h.stop()));
      await db.close();
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkers()
    .then((worker) => {
      // Encerramento limpo: termina o job em andamento antes de sair, em vez
      // de morrer no meio e deixar o lease expirar.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          void worker.stop().then(() => process.exit(0));
        });
      }
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      process.exit(1);
    });
}
