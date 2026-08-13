/**
 * Verificação de assinatura de webhook.
 *
 * Implementa exatamente o esquema documentado pelo operador:
 *
 *   X-DePix-Signature: t=<unix_ts>,v1=<hmac_sha256_hex>
 *   assinatura = HMAC-SHA256(secret, "{t}.{raw_body}")
 *
 * Três armadilhas que este módulo existe para evitar:
 *
 *  1. **Reserializar o corpo antes de verificar.** Se o corpo for parseado
 *     como JSON e reserializado, um espaço a mais quebra a assinatura. Por
 *     isso a função recebe `Buffer`, não objeto.
 *  2. **Comparação de string com `===`.** Vaza informação por tempo.
 *     Usa-se `timingSafeEqual`.
 *  3. **Aceitar timestamp antigo.** Sem janela, uma requisição capturada
 *     pode ser reenviada indefinidamente.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookVerification } from '../types.ts';

/** Janela de tolerância. 5 minutos cobre atraso de rede e relógio. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyOptions {
  readonly secret: string;
  readonly toleranceSeconds?: number;
  /** Injetável para teste determinístico. */
  readonly now?: () => number;
}

interface ParsedSignature {
  timestamp: number;
  v1: string;
}

function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  let v1: string | null = null;

  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && Number.isInteger(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      v1 = value;
    }
  }

  if (timestamp === null || v1 === null || !/^[0-9a-f]+$/i.test(v1)) return null;
  return { timestamp, v1 };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige mesmo tamanho; comparar o tamanho antes vaza
  // apenas o comprimento, que não é segredo.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Lê um header de forma case-insensitive. */
export function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Verifica a assinatura.
 *
 * `rawBody` precisa ser exatamente os bytes recebidos. O framework HTTP
 * tem de estar configurado para preservá-los antes do parse de JSON.
 */
export function verifyDepixWebhook(
  rawBody: Buffer,
  headers: Readonly<Record<string, string>>,
  opts: VerifyOptions,
): WebhookVerification {
  const eventId = header(headers, 'x-depix-event-id');
  const eventName = header(headers, 'x-depix-event');
  const signatureHeader = header(headers, 'x-depix-signature');

  const base = { eventId, eventName };

  if (!signatureHeader) {
    return { ...base, valid: false, reason: 'assinatura ausente' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ...base, valid: false, reason: 'formato de assinatura inválido' };
  }

  const nowSeconds = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const age = Math.abs(nowSeconds - parsed.timestamp);
  if (age > tolerance) {
    return {
      ...base,
      valid: false,
      reason: `timestamp fora da janela (${age}s de diferença, tolerância ${tolerance}s)`,
    };
  }

  const expected = createHmac('sha256', opts.secret)
    .update(`${parsed.timestamp}.`)
    .update(rawBody)
    .digest('hex');

  if (!constantTimeEquals(expected, parsed.v1.toLowerCase())) {
    return { ...base, valid: false, reason: 'assinatura não confere' };
  }

  return { ...base, valid: true };
}

/** Produz uma assinatura no formato do provider. Usado em teste e no sandbox. */
export function signDepixWebhook(
  rawBody: Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  const v1 = createHmac('sha256', secret)
    .update(`${timestampSeconds}.`)
    .update(rawBody)
    .digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}
