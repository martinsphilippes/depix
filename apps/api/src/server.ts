/**
 * API HTTP.
 *
 * Fastify com duas particularidades que não são detalhe:
 *
 *  1. O endpoint de webhook precisa dos **bytes brutos** do corpo. Um parser
 *     de JSON que reserializa quebra a verificação de assinatura, então há um
 *     content-type parser dedicado que guarda o Buffer original.
 *  2. Nenhuma rota financeira responde antes do commit no Firestore.
 *     "Aceito" no HTTP tem de significar "gravado".
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import {
  DomainError,
  IntegrationPendingError,
  ProviderError,
  formatBRL,
  money,
  parseUserAmount,
  rescale,
} from '@depix/core';
import { type Db, createDb, createFirestore } from '@depix/firestore';
import { walletBalance } from '@depix/ledger';
import {
  DepixAppProvider,
  type DepixProvider,
  LIGHTNING_UNAVAILABLE_MESSAGE,
  PendingPixProvider,
  RECIPIENT_UNKNOWN_NOTICE,
  SandboxDepixProvider,
  maskPixKey,
} from '@depix/providers';
import {
  type HistoryItem,
  createDepositIntent,
  enqueueConfirmation,
  getWalletStatus,
  ingestWebhook,
  loadEncryptionKey,
  markBackupConfirmed,
  markSendBroadcast,
  registerWallet,
  listHistory,
  periodRange,
  prepareDepixSend,
  resolveSession,
  transactionTimeline,
} from '@depix/app';
import { getTransaction } from '@depix/app';

import { type AppConfig, loadConfig, startupBanner } from './config.ts';

export interface ServerDeps {
  readonly config: AppConfig;
  readonly db: Db;
  readonly depixProvider: DepixProvider;
  /** Chave AES-256-GCM para cifrar o descriptor watch-only em repouso. */
  readonly encryptionKey: Buffer;
}

export function buildDepixProvider(config: AppConfig): DepixProvider {
  if (config.depix.providerCode === 'sandbox') {
    return new SandboxDepixProvider({ webhookSecret: config.depix.webhookSecret });
  }
  if (config.depix.providerCode === 'depixapp') {
    if (!config.depix.apiKey || !config.depix.webhookSecret) {
      throw new DomainError('missing_config', 'DEPIX_API_KEY e DEPIX_WEBHOOK_SECRET são obrigatórios');
    }
    return new DepixAppProvider({
      apiKey: config.depix.apiKey,
      webhookSecret: config.depix.webhookSecret,
      environment: config.environment,
      ...(config.depix.baseUrl ? { baseUrl: config.depix.baseUrl } : {}),
    });
  }
  throw new IntegrationPendingError(
    `adapter do provider "${config.depix.providerCode}"`,
    'apenas sandbox e depixapp estão implementados nesta etapa',
  );
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      // Redaction obrigatória (SECURITY.md §9).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-depix-signature"]',
          'res.headers["set-cookie"]',
          'req.body.taxNumber',
          'req.body.pixKey',
          'req.body.seed',
          'req.body.mnemonic',
          'req.body.password',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1_048_576,
  });

  // --- Parser de corpo bruto para webhooks ---------------------------------
  // Guarda o Buffer original ANTES de qualquer parse. Sem isto, a verificação
  // de assinatura seria feita sobre bytes reserializados e falharia (ou,
  // pior, passaria a ser afrouxada para "funcionar").
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest & { rawBody?: Buffer }, body: Buffer, done) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(new DomainError('invalid_json', 'Corpo da requisição não é JSON válido'), undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IntegrationPendingError) {
      // 501: não é erro do cliente nem falha nossa — é funcionalidade que
      // ainda não existe, e a resposta diz do que ela depende.
      return reply.status(501).send({
        error: { code: error.code, message: error.message, pendingOn: error.details['pendingOn'] },
      });
    }
    if (error instanceof ProviderError) {
      return reply.status(error.retryable ? 503 : 502).send({
        error: {
          code: error.code,
          providerCode: error.details['providerCode'],
          message: error.message,
        },
      });
    }
    if (error instanceof DomainError) {
      const status = STATUS_BY_CODE[error.code] ?? 400;
      return reply.status(status).send({ error: { code: error.code, message: error.message } });
    }
    request.log.error({ err: error }, 'erro não tratado');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Erro interno' } });
  });

  // --- Autenticação ---------------------------------------------------------
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({ error: { code: 'unauthenticated', message: 'Sessão ausente' } });
    }
    const session = await resolveSession(deps.db, token);
    if (!session) {
      return reply
        .status(401)
        .send({ error: { code: 'session_invalid', message: 'Sessão inválida ou expirada' } });
    }
    (request as FastifyRequest & { session?: unknown }).session = session;
  }

  const authed = { preHandler: authenticate };

  // --- Saúde ----------------------------------------------------------------
  app.get('/health', async () => {
    const checks: Record<string, string> = {};
    try {
      await deps.db.collection('assets').limit(1).get();
      checks['firestore'] = 'ok';
    } catch {
      checks['firestore'] = 'fail';
    }
    return {
      status: Object.values(checks).every((v) => v === 'ok') ? 'ok' : 'degraded',
      environment: deps.config.environment,
      realFunds: deps.config.realFundsEnabled,
      emulated: Boolean(deps.config.firebase.emulatorHost),
      provider: deps.depixProvider.info.code,
      checks,
    };
  });

  // --- Carteira -------------------------------------------------------------
  app.get('/wallet/balance', authed, async (request) => {
    const { userId } = sessionOf(request);
    const depix = await walletBalance(deps.db, userId, 'DEPIX');

    // O usuário vê reais. O DePix é detalhe de infraestrutura.
    const toBrl = (v: bigint) => rescale(money('DEPIX', v), 'BRL', 'floor');

    return {
      total: formatBRL(toBrl(depix.available.amount)),
      totalCents: toBrl(depix.available.amount).amount.toString(),
      pendingIn: formatBRL(toBrl(depix.pendingIn.amount)),
      pendingOut: formatBRL(toBrl(depix.pendingOut.amount)),
      assets: [
        {
          code: 'DEPIX',
          displayName: 'DePix',
          amount: depix.available.amount.toString(),
          equivalentBrl: formatBRL(toBrl(depix.available.amount)),
          network: 'Liquid Network',
        },
      ],
    };
  });

  // --- Registro da carteira -------------------------------------------------
  // O usuário gera as chaves no dispositivo e envia apenas o descriptor
  // watch-only. O servidor recusa qualquer coisa com cara de chave privada.
  app.post('/wallet', authed, async (request, reply) => {
    const { userId } = sessionOf(request);
    const body = request.body as { ctDescriptor?: string; network?: string };

    if (!body.ctDescriptor) {
      throw new DomainError('missing_descriptor', 'Informe o descriptor da carteira');
    }
    const network = body.network === 'mainnet' ? 'mainnet' : 'testnet';

    const result = await registerWallet(deps.db, {
      userId,
      ctDescriptor: body.ctDescriptor,
      network,
      encryptionKey: deps.encryptionKey,
    });

    return reply.status(result.created ? 201 : 200).send({
      walletId: result.walletId,
      registered: true,
      network,
    });
  });

  app.get('/wallet', authed, async (request) => {
    const { userId } = sessionOf(request);
    const status = await getWalletStatus(deps.db, userId);
    return status ?? { registered: false, backupConfirmed: false };
  });

  app.post('/wallet/backup-confirmed', authed, async (request) => {
    const { userId } = sessionOf(request);
    await markBackupConfirmed(deps.db, userId);
    return { backupConfirmed: true };
  });

  // --- Receber Pix ----------------------------------------------------------
  app.post('/pix/deposits', authed, async (request, reply) => {
    const { userId } = sessionOf(request);
    const body = request.body as { amount?: string; destinationAddress?: string };

    if (!body.destinationAddress) {
      throw new DomainError('missing_address', 'Informe o endereço da sua carteira para receber');
    }
    const amount = parseUserAmount(String(body.amount ?? ''), 'BRL');

    const intent = await createDepositIntent(
      deps.db,
      { provider: deps.depixProvider },
      {
        userId,
        amountBrlCents: amount.amount,
        destinationAddress: body.destinationAddress,
      },
    );

    return reply.status(201).send({
      transactionId: intent.transactionId,
      amount: formatBRL(intent.amountBrl),
      qrCopyPaste: intent.qrCopyPaste,
      qrImageUrl: intent.qrImageUrl,
      expiresAt: intent.expiresAt,
      status: 'Aguardando pagamento',
      // Deixa explícito na resposta quando nada disso é real.
      sandbox: !deps.depixProvider.info.handlesRealFunds,
    });
  });

  // --- Enviar DePix ---------------------------------------------------------
  app.post('/depix/sends', authed, async (request, reply) => {
    const { userId } = sessionOf(request);
    const body = request.body as { amount?: string; destinationAddress?: string };

    if (!body.destinationAddress) {
      throw new DomainError('missing_address', 'Informe o endereço de destino');
    }
    const amountBrl = parseUserAmount(String(body.amount ?? ''), 'BRL');
    const amountDepix = rescale(amountBrl, 'DEPIX');

    const review = await prepareDepixSend(deps.db, {
      userId,
      destinationAddress: body.destinationAddress,
      amount: amountDepix,
    });

    const toBrl = (v: bigint) => formatBRL(rescale(money('DEPIX', v), 'BRL', 'floor'));

    return reply.status(201).send({
      transactionId: review.transactionId,
      destination: review.destination,
      network: 'Liquid Network',
      amount: toBrl(review.breakdown.principal.amount),
      fee: toBrl(review.breakdown.totalFee.amount),
      total: toBrl(review.breakdown.totalDebit.amount),
      remainingAfter: toBrl(review.remainingAfter.amount),
      // A transação é montada e assinada no dispositivo do usuário. O
      // servidor não tem — e não terá — como assinar por ele.
      nextStep: 'sign_on_device',
    });
  });

  // --- Confirmação de transmissão -------------------------------------------
  // O cliente montou, validou, assinou e transmitiu. Aqui ele só informa o
  // txid resultante — o servidor não assinou nada e não teria como.
  app.post('/depix/sends/:id/broadcast', authed, async (request, reply) => {
    const { userId } = sessionOf(request);
    const { id } = request.params as { id: string };
    const body = request.body as { txid?: string };

    if (!body.txid || !/^[0-9a-f]{64}$/i.test(body.txid)) {
      throw new DomainError('invalid_txid', 'Informe o TXID de 64 caracteres hexadecimais');
    }

    const transaction = await getTransaction(deps.db, id);
    if (!transaction || transaction.userId !== userId) {
      throw new DomainError('transaction_not_found', 'Transação não encontrada');
    }

    await markSendBroadcast(deps.db, {
      transactionId: id,
      txid: body.txid.toLowerCase(),
      amount: transaction.amount,
      actor: `user:${userId}`,
    });

    // A partir daqui quem conclui é o worker, ao ver confirmações reais.
    await enqueueConfirmation(deps.db, {
      transactionId: id,
      txid: body.txid.toLowerCase(),
      kind: 'send',
    });

    return reply.status(202).send({
      transactionId: id,
      txid: body.txid.toLowerCase(),
      status: 'Confirmando',
    });
  });

  // --- Enviar Pix (saque) ---------------------------------------------------
  app.post('/pix/withdrawals/preview', authed, async (request) => {
    const body = request.body as { pixKey?: string };
    if (!body.pixKey) throw new DomainError('missing_pix_key', 'Informe a chave Pix');

    const pix = new PendingPixProvider();
    const validation = await pix.validatePixKey(body.pixKey);

    // Sem DICT, não temos o nome do recebedor — e não vamos inventá-lo.
    return {
      keyMasked: maskPixKey(body.pixKey),
      keyType: validation.keyType,
      formatValid: validation.valid,
      recipientName: null,
      recipientInstitution: null,
      notice: RECIPIENT_UNKNOWN_NOTICE,
    };
  });

  // --- Lightning ------------------------------------------------------------
  app.get('/lightning/status', async () => ({
    available: false,
    message: LIGHTNING_UNAVAILABLE_MESSAGE,
    reason:
      'DePix é emitido na Liquid Network; Taproot Assets opera no Bitcoin mainnet. ' +
      'Não há ponte documentada entre as duas.',
  }));

  // --- Extrato --------------------------------------------------------------
  app.get('/history', authed, async (request) => {
    const { userId } = sessionOf(request);
    const query = request.query as { period?: string; limit?: string };

    const range =
      query.period && ['today', '7d', '30d', 'month'].includes(query.period)
        ? periodRange(query.period as 'today' | '7d' | '30d' | 'month')
        : undefined;

    const items = await listHistory(deps.db, {
      userId,
      ...(range ? { from: range.from, to: range.to } : {}),
      limit: query.limit ? Number(query.limit) : 50,
    });

    // Quantias saem como string, nunca como bigint: `JSON.stringify` lança em
    // bigint, e uma resposta que derruba a requisição por causa de um valor
    // grande é o tipo de falha que só aparece em produção.
    return { items: items.map(toApiHistoryItem) };
  });

  app.get('/transactions/:id/timeline', authed, async (request) => {
    const { id } = request.params as { id: string };
    const events = await transactionTimeline(deps.db, id);
    return { events };
  });

  // --- Webhook --------------------------------------------------------------
  // Responde rápido e não processa nada de forma síncrona.
  app.post('/webhooks/depix', async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      return reply.status(400).send({ error: { code: 'missing_raw_body' } });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }

    const result = await ingestWebhook(deps.db, { provider: deps.depixProvider }, { rawBody: raw, headers });

    if (result.outcome === 'invalid_signature') {
      request.log.warn({ eventId: result.webhookEventId }, 'webhook com assinatura inválida');
    }

    return reply.status(result.httpStatus).send({ received: result.outcome !== 'invalid_signature' });
  });

  return app;
}

// ---------------------------------------------------------------------------

/**
 * Converte um item do extrato para o formato de resposta.
 *
 * A única regra que importa aqui: **nenhum `bigint` atravessa a fronteira
 * HTTP**. Quantia vira string; contador vira number. Deixar um bigint passar
 * faz o serializador do Fastify lançar em tempo de execução.
 */
function toApiHistoryItem(item: HistoryItem): Record<string, unknown> {
  return {
    transactionId: item.transactionId,
    kind: item.kind,
    status: item.status,
    statusLabel: item.statusLabel,
    direction: item.direction,
    title: item.title,
    amountLabel: item.amountLabel,
    amountBrlCents: item.amountBrlCents.toString(),
    feeBrlCents: item.feeBrlCents.toString(),
    counterparty: item.counterparty,
    createdAt: item.createdAt.toISOString(),
    completedAt: item.completedAt?.toISOString() ?? null,
    technical: item.technical,
  };
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  insufficient_funds: 422,
  invalid_amount: 400,
  invalid_idempotency_key: 400,
  rate_limited: 429,
  reauth_required: 403,
  transaction_not_found: 404,
  unknown_ledger_account: 404,
  invalid_transition: 409,
  asset_id_mismatch: 422,
  duplicate_e2e_id: 409,
  amount_out_of_range: 400,
  ledger_invariant_violated: 500,
};

function extractToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.cookie;
  const match = cookie?.match(/(?:^|;\s*)session=([^;]+)/);
  return match?.[1] ?? null;
}

function sessionOf(request: FastifyRequest): { userId: string; id: string } {
  const session = (request as FastifyRequest & { session?: { userId: string; id: string } }).session;
  if (!session) throw new DomainError('unauthenticated', 'Sessão ausente');
  return session;
}

// ---------------------------------------------------------------------------

export async function start(): Promise<void> {
  const config = loadConfig();

  const fs = createFirestore({
    projectId: config.firebase.projectId,
    ...(config.firebase.emulatorHost ? { emulatorHost: config.firebase.emulatorHost } : {}),
    ...(config.firebase.databaseId ? { databaseId: config.firebase.databaseId } : {}),
  });
  const db = createDb(fs);
  const depixProvider = buildDepixProvider(config);

  const app = await buildServer({ config, db, depixProvider, encryptionKey: loadEncryptionKey() });
  app.log.info(startupBanner(config));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}
