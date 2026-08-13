/**
 * Recepção de webhooks.
 *
 * A ordem abaixo é o contrato do módulo, e cada passo existe por um motivo:
 *
 *   1. ler os BYTES BRUTOS      → a assinatura cobre os bytes, não o objeto
 *   2. verificar a assinatura   → antes de confiar em qualquer campo
 *   3. gravar o evento bruto    → inclusive quando inválido (valor forense)
 *   4. deduplicar               → entrega é at-least-once por contrato
 *   5. responder 2xx rápido     → o provider tem timeout
 *   6. processar assíncrono     → fora do ciclo do request
 *
 * O processamento **nunca** acontece dentro do handler HTTP. Um webhook que
 * demora a responder é reenviado, e reenvio durante processamento é como se
 * criam créditos duplicados.
 */

import { DomainError } from '@depix/core';
import type { Db, Queryable } from '@depix/db';
import type { DepixProvider } from '@depix/providers';

export type IngestOutcome = 'accepted' | 'duplicate' | 'invalid_signature';

export interface IngestResult {
  readonly outcome: IngestOutcome;
  readonly webhookEventId: string | null;
  /** Status HTTP a devolver ao provider. */
  readonly httpStatus: number;
}

/**
 * Passo 1–4. Rápido e sem efeito financeiro.
 *
 * Assinatura inválida devolve 400 e **não** enfileira. Duplicata devolve
 * 200 sem enfileirar de novo — reclamar de duplicata faria o provider
 * insistir com o mesmo evento.
 */
export async function ingestWebhook(
  db: Db,
  deps: { provider: DepixProvider },
  input: { rawBody: Buffer; headers: Readonly<Record<string, string>> },
): Promise<IngestResult> {
  const verification = deps.provider.verifyWebhook(input.rawBody, input.headers);

  const providerId = await resolveProviderId(db, deps.provider.info.code, deps.provider.info.environment);

  // Grava sempre — inclusive assinatura inválida. Uma sequência de eventos
  // não assinados é sinal de ataque, e apagar isso é perder a evidência.
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO webhook_events
       (provider_id, external_id, event_name, signature_ok, raw_headers, raw_body)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider_id, external_id) DO NOTHING
     RETURNING id`,
    [
      providerId,
      verification.eventId ?? null,
      verification.eventName ?? null,
      verification.valid,
      JSON.stringify(redactHeaders(input.headers)),
      input.rawBody.toString('utf8'),
    ],
  );

  if (!verification.valid) {
    return {
      outcome: 'invalid_signature',
      webhookEventId: inserted.rows[0]?.id ?? null,
      httpStatus: 400,
    };
  }

  if (inserted.rows.length === 0) {
    // Já tínhamos este evento. Reconhecer com 200 encerra as retentativas.
    return { outcome: 'duplicate', webhookEventId: null, httpStatus: 200 };
  }

  const eventId = inserted.rows[0]!.id;

  await db.query(
    `INSERT INTO job_queue (queue, payload, dedupe_key)
     VALUES ('webhook', $1::jsonb, $2)
     ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND completed_at IS NULL
     DO NOTHING`,
    [JSON.stringify({ webhookEventId: eventId }), `webhook:${eventId}`],
  );

  return { outcome: 'accepted', webhookEventId: eventId, httpStatus: 200 };
}

/** Marca o evento como processado. Chamado pelo worker, não pelo handler. */
export async function markWebhookProcessed(
  tx: Queryable,
  params: { webhookEventId: string; result: string },
): Promise<void> {
  await tx.query(
    'UPDATE webhook_events SET processed_at = now(), process_result = $2 WHERE id = $1',
    [params.webhookEventId, params.result],
  );
}

async function resolveProviderId(db: Db, code: string, environment: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM providers WHERE code = $1 AND environment = $2::env_kind LIMIT 1',
    [code, environment],
  );
  if (!rows[0]) {
    throw new DomainError('unknown_provider', `Provider ${code}/${environment} não cadastrado`);
  }
  return rows[0].id;
}

/**
 * Headers gravados sem os que carregam segredo.
 *
 * A assinatura em si é guardada (é dado do evento, não credencial), mas
 * `authorization` e cookies nunca entram no banco.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const blocked = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = blocked.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}
