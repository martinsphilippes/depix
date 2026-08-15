/**
 * O worker, adaptado ao serverless.
 *
 * Fora daqui o worker é um processo contínuo, e é assim que deve ser: seguir
 * confirmações on-chain é trabalho longo. A Vercel não hospeda processo
 * contínuo, então o mesmo trabalho vira uma varredura periódica disparada por
 * cron.
 *
 * A diferença é de latência, não de correção: uma transação demora até um
 * ciclo a mais para ser confirmada. O que **não** muda é a regra de que só o
 * worker conclui uma transação, depois de ver confirmação real na cadeia.
 *
 * ⚠️ Rota protegida. Sem isso qualquer um dispara conciliação e drena a cota
 * do Firestore — e o `CRON_SECRET` da Vercel chega como Bearer no cabeçalho.
 */

import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<Response> {
  const segredo = process.env['CRON_SECRET'];
  const autorizacao = request.headers.get('authorization');

  if (segredo && autorizacao !== `Bearer ${segredo}`) {
    return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  const { loadConfig } = await import('@depix/api/config');
  const { createDb, createFirestore } = await import('@depix/firestore');
  const { EsploraLiquidProvider } = await import('@depix/providers');
  const { buildDepixProvider } = await import('@depix/api/server');
  const {
    QUEUES,
    createConfirmationHandler,
    createWebhookHandler,
    drainQueue,
    runReconciliation,
  } = await import('@depix/app');

  const config = loadConfig();
  const db = createDb(
    createFirestore({
      projectId: config.firebase.projectId,
      ...(config.firebase.emulatorHost ? { emulatorHost: config.firebase.emulatorHost } : {}),
      ...(config.firebase.databaseId ? { databaseId: config.firebase.databaseId } : {}),
      ...(config.firebase.credentials ? { credentials: config.firebase.credentials } : {}),
    }),
  );

  try {
    // Esvazia as filas com teto de tempo: a função tem 60 s, e estourar
    // significa ser morta no meio de um job. O lease expira e o próximo ciclo
    // reprocessa — nenhum trabalho se perde, mas é melhor sair pela porta.
    const webhooks = await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider: buildDepixProvider(config) }),
      workerId: 'vercel-cron',
      budgetMs: 20_000,
    });

    const confirmacoes = await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid: new EsploraLiquidProvider() }),
      workerId: 'vercel-cron',
      budgetMs: 20_000,
    });

    const conciliacao = await runReconciliation(db, { trigger: 'scheduled' });

    return Response.json({
      webhooks,
      confirmacoes,
      conciliacao: {
        runId: conciliacao.runId,
        limpo: conciliacao.clean,
        achados: conciliacao.findings,
        contas: conciliacao.accountsChecked,
      },
    });
  } finally {
    await db.close();
  }
}
