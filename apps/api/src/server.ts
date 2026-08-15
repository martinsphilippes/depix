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
import cors from '@fastify/cors';

import {
  DEPIX_LIQUID_ASSET_ID,
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
  type Contact,
  type HistoryItem,
  type SessionRecord,
  adminUserSummary,
  assertAdmin,
  listAuditLogs,
  listForReview,
  setUserStatus,
  writeAuditLog,
  assertFreshReauth,
  changeContactDestination,
  changePassword,
  createDepositIntent,
  hasPassword,
  registerWithPassword,
  setPassword,
  verifyPassword,
  deleteContact,
  enforcePolicy,
  findContactByDestination,
  listContacts,
  listNotifications,
  listOpenFindings,
  listRuns,
  markAllRead,
  markContactUsed,
  markRead,
  resolveFinding,
  runReconciliation,
  saveContact,
  unreadCount,
  evaluateSendPolicy,
  assertWithinRateLimit,
  createSession,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  hashIp,
  isDeviceTrusted,
  listCredentials,
  markReauth,
  recordAttempt,
  removeCredential,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  limitsSummary,
  reauthThresholdLabel,
  withRateLimit,
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

  // --- CORS -----------------------------------------------------------------
  // A interface roda numa origem (`localhost:3000`) e a API em outra
  // (`localhost:3001`), então sem isto o navegador bloqueia toda chamada.
  //
  // Duas escolhas que não são detalhe:
  //
  //   • lista fixa de origens, nunca `*`. Com `credentials: true` o `*` é
  //     recusado pelo próprio navegador, e mesmo que não fosse, seria
  //     autorizar qualquer site a agir em nome do usuário logado;
  //   • as origens são as **mesmas** do WebAuthn. Não é economia de
  //     configuração: são literalmente o mesmo fato — a origem da nossa
  //     interface — e mantê-lo em dois lugares é convidar os dois a divergirem
  //     em produção, justamente onde o erro custa caro.
  await app.register(cors, {
    origin: deps.config.webauthn.origin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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

  /**
   * Autenticação opcional: resolve a sessão se houver, e segue sem ela se não.
   *
   * Existe para o registro de passkey, que serve a dois casos com a mesma
   * rota — criar conta nova e acrescentar uma passkey a quem já está logado.
   *
   * ⚠️ A ausência disto era um bug sério: a rota lia `request.session`, nada a
   * preenchia, e o resultado era que quem já tinha conta e cadastrava uma
   * passkey recebia uma **conta nova e vazia** — com a sessão trocada por
   * baixo, o saldo e o histórico sumindo da tela. Encontrado percorrendo o
   * sistema num navegador; nenhum teste pegava porque todos chamavam a função
   * de registro direto, passando `userId` na mão.
   */
  async function maybeAuthenticate(request: FastifyRequest) {
    const token = extractToken(request);
    if (!token) return;
    const session = await resolveSession(deps.db, token);
    if (session) {
      (request as FastifyRequest & { session?: unknown }).session = session;
    }
  }

  const maybeAuthed = { preHandler: maybeAuthenticate };

  /**
   * Sujeitos do rate limiting: conta E IP.
   *
   * Só por IP não protege contra botnet; só por conta permite que um atacante
   * tranque a conta alheia de propósito. O IP entra como hash com salt — sem
   * o salt, o hash seria reversível por força bruta, já que o espaço de
   * endereços IPv4 inteiro cabe numa tabela.
   */
  function rateSubjects(request: FastifyRequest): { accountSubject?: string; ipSubject?: string } {
    const session = (request as FastifyRequest & { session?: SessionRecord }).session;
    const ip = request.ip;
    return {
      ...(session ? { accountSubject: `user:${session.userId}` } : {}),
      ...(ip ? { ipSubject: `ip:${hashIp(ip, deps.config.ipHashSalt)}` } : {}),
    };
  }

  // A reautenticação por passkey existe: operações que disparam a política
  // podem ser confirmadas em vez de bloqueadas.
  const REAUTH_AVAILABLE = true;

  const webauthn = deps.config.webauthn;
  const waConfig = {
    rpName: webauthn.rpName,
    rpID: webauthn.rpID,
    origin: webauthn.origin,
  };

  /** Cookie de sessão: HttpOnly impede o JavaScript da página de lê-lo. */
  function setSessionCookie(reply: FastifyReply, token: string): void {
    const secure = deps.config.environment === 'production' ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `session=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${30 * 24 * 60 * 60}`,
    );
  }

  // --- Passkeys -------------------------------------------------------------

  app.post('/auth/register/start', maybeAuthed, async (request) => {
    const body = request.body as { handle?: string };
    const existing = (request as FastifyRequest & { session?: SessionRecord }).session;

    const start = await startPasskeyRegistration(deps.db, {
      config: waConfig,
      ...(existing ? { userId: existing.userId } : {}),
      ...(body?.handle ? { handle: body.handle } : {}),
    });

    // O userId volta só para diagnóstico: quem manda no `finish` é o
    // challenge guardado no servidor, não um campo enviado pelo cliente.
    return { options: start.options };
  });

  app.post('/auth/register/finish', maybeAuthed, async (request, reply) => {
    const body = request.body as { response?: unknown; label?: string };
    const sessaoAtual = (request as FastifyRequest & { session?: SessionRecord }).session;
    if (!body?.response) throw new DomainError('missing_response', 'Resposta da passkey ausente');

    const result = await finishPasskeyRegistration(deps.db, {
      config: waConfig,
      response: body.response as never,
      ...(body.label ? { label: body.label } : {}),
    });

    // Quem já estava logado continua na mesma sessão: acrescentar uma passkey
    // não é entrar de novo, e trocar a sessão aqui foi exatamente o que
    // fazia o saldo sumir da tela.
    if (sessaoAtual && sessaoAtual.userId === result.userId) {
      return reply.status(201).send({
        userId: result.userId,
        backedUp: result.backedUp,
        warning: null,
      });
    }

    const ip = request.ip;
    const { token } = await createSession(deps.db, {
      userId: result.userId,
      ...(ip ? { ipHash: hashIp(ip, deps.config.ipHashSalt) } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      freshAuth: true,
    });

    setSessionCookie(reply, token);
    return reply.status(201).send({
      token,
      userId: result.userId,
      backedUp: result.backedUp,
      // Sem backup no dispositivo, perder o aparelho perde a passkey — e com
      // ela o acesso. O usuário precisa saber disso agora, não depois.
      warning: result.backedUp
        ? null
        : 'Esta passkey não tem backup. Se você perder este dispositivo, perderá o acesso. Cadastre uma segunda passkey.',
    });
  });

  // --- Senha ----------------------------------------------------------------
  //
  // Convive com a passkey, não a substitui. A passkey continua sendo o fator
  // mais forte — resiste a phishing, e senha nenhuma resiste —, mas quem
  // prefere senha entra com senha, e as duas podem coexistir na mesma conta.

  app.post('/auth/password/register', async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    if (!body?.identifier || !body?.password) {
      throw new DomainError('missing_credentials', 'Informe e-mail (ou usuário) e senha');
    }

    const ip = request.ip;
    const ipSubject = ip ? `ip:${hashIp(ip, deps.config.ipHashSalt)}` : undefined;
    await assertWithinRateLimit(deps.db, {
      kind: 'signup',
      ...(ipSubject ? { ipSubject } : {}),
    });

    const conta = await registerWithPassword(deps.db, {
      identifier: body.identifier,
      password: body.password,
    });

    const { token } = await createSession(deps.db, {
      userId: conta.userId,
      ...(ip ? { ipHash: hashIp(ip, deps.config.ipHashSalt) } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      freshAuth: true,
    });

    setSessionCookie(reply, token);
    return reply.status(201).send({ token, userId: conta.userId });
  });

  app.post('/auth/password/login', async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    if (!body?.identifier || !body?.password) {
      throw new DomainError('missing_credentials', 'Informe e-mail (ou usuário) e senha');
    }

    const ip = request.ip;
    const ipSubject = ip ? `ip:${hashIp(ip, deps.config.ipHashSalt)}` : undefined;
    // Também por identificador: só por IP não protege a conta de alguém atrás
    // de uma botnet, e só por conta deixa um atacante trancar a conta alheia.
    const accountSubject = `login:${body.identifier.trim().toLowerCase()}`;

    await assertWithinRateLimit(deps.db, {
      kind: 'login',
      accountSubject,
      ...(ipSubject ? { ipSubject } : {}),
    });

    let conta;
    try {
      conta = await verifyPassword(deps.db, {
        identifier: body.identifier,
        password: body.password,
      });
    } catch (err) {
      // Falha conta para o rate limiting; acerto não penaliza quem errou antes.
      await recordAttempt(deps.db, { subject: accountSubject, kind: 'login', succeeded: false });
      if (ipSubject) {
        await recordAttempt(deps.db, { subject: ipSubject, kind: 'login', succeeded: false });
      }
      throw err;
    }

    const { token } = await createSession(deps.db, {
      userId: conta.userId,
      ...(ip ? { ipHash: hashIp(ip, deps.config.ipHashSalt) } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      freshAuth: true,
    });

    setSessionCookie(reply, token);
    return { token, userId: conta.userId };
  });

  app.post('/auth/password/change', authed, async (request) => {
    const session = sessionOf(request);
    const body = request.body as { currentPassword?: string; newPassword?: string };
    if (!body?.currentPassword || !body?.newPassword) {
      throw new DomainError('missing_credentials', 'Informe a senha atual e a nova');
    }

    await changePassword(deps.db, {
      userId: session.userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    return { changed: true };
  });

  /**
   * Define senha numa conta que só tinha passkey.
   *
   * Exige confirmação recente: sem isso, uma sessão roubada acrescentaria uma
   * senha conhecida pelo atacante a uma conta que só o dono acessava.
   */
  app.post('/auth/password/set', authed, async (request) => {
    const session = sessionOf(request);
    const body = request.body as { identifier?: string; password?: string };
    if (!body?.identifier || !body?.password) {
      throw new DomainError('missing_credentials', 'Informe e-mail (ou usuário) e senha');
    }

    assertFreshReauth(session, 'definir senha');

    await setPassword(deps.db, {
      userId: session.userId,
      identifier: body.identifier,
      password: body.password,
    });

    return { set: true };
  });

  app.get('/auth/methods', authed, async (request) => {
    const { userId } = sessionOf(request);
    const [senha, credenciais] = await Promise.all([
      hasPassword(deps.db, userId),
      listCredentials(deps.db, userId),
    ]);
    return { password: senha, passkeys: credenciais.length };
  });

  app.post('/auth/login/start', async () => {
    // Sem allowCredentials: login sem digitar identificador nenhum.
    const start = await startPasskeyAuthentication(deps.db, { config: waConfig });
    return { options: start.options };
  });

  app.post('/auth/login/finish', async (request, reply) => {
    const body = request.body as { response?: unknown };
    if (!body?.response) throw new DomainError('missing_response', 'Resposta da passkey ausente');

    const ip = request.ip;
    const ipSubject = ip ? `ip:${hashIp(ip, deps.config.ipHashSalt)}` : undefined;
    await assertWithinRateLimit(deps.db, {
      kind: 'login',
      ...(ipSubject ? { ipSubject } : {}),
    });

    let result;
    try {
      result = await finishPasskeyAuthentication(deps.db, {
        config: waConfig,
        response: body.response as never,
      });
    } catch (err) {
      // Falha conta para o rate limiting; sucesso não penaliza quem errou antes.
      if (ipSubject) {
        await recordAttempt(deps.db, { subject: ipSubject, kind: 'login', succeeded: false });
      }
      throw err;
    }

    const { token } = await createSession(deps.db, {
      userId: result.userId,
      ...(ip ? { ipHash: hashIp(ip, deps.config.ipHashSalt) } : {}),
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      freshAuth: true,
    });

    setSessionCookie(reply, token);
    return { token, userId: result.userId };
  });

  // Reautenticação: confirma identidade sobre uma sessão que já existe.
  app.post('/auth/reauth/start', authed, async (request) => {
    const session = sessionOf(request);
    const start = await startPasskeyAuthentication(deps.db, {
      config: waConfig,
      purpose: 'reauth',
      userId: session.userId,
      sessionId: session.id,
    });
    return { options: start.options };
  });

  app.post('/auth/reauth/finish', authed, async (request) => {
    const session = sessionOf(request);
    const body = request.body as { response?: unknown };
    if (!body?.response) throw new DomainError('missing_response', 'Resposta da passkey ausente');

    const result = await finishPasskeyAuthentication(deps.db, {
      config: waConfig,
      purpose: 'reauth',
      response: body.response as never,
    });

    if (result.userId !== session.userId || result.sessionId !== session.id) {
      throw new DomainError('reauth_session_mismatch', 'A confirmação não corresponde a esta sessão');
    }

    await markReauth(deps.db, session.id);
    return { confirmed: true };
  });

  app.get('/auth/credentials', authed, async (request) => {
    const { userId } = sessionOf(request);
    return { credentials: await listCredentials(deps.db, userId) };
  });

  app.delete('/auth/credentials/:id', authed, async (request) => {
    const { userId } = sessionOf(request);
    const { id } = request.params as { id: string };
    await removeCredential(deps.db, { userId, credentialId: id });
    return { removed: true };
  });

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

  // Limites e política: o usuário deveria ver o limite antes de esbarrar nele.
  app.get('/wallet/limits', authed, async (request) => {
    const { userId } = sessionOf(request);
    const summary = await limitsSummary(deps.db, userId);
    return {
      ...summary,
      reauthThreshold: reauthThresholdLabel(),
      reauthAvailable: REAUTH_AVAILABLE,
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

    const result = await withRateLimit(
      deps.db,
      { kind: 'wallet_register', ...rateSubjects(request) },
      () =>
        registerWallet(deps.db, {
          userId,
          ctDescriptor: body.ctDescriptor!,
          network,
          encryptionKey: deps.encryptionKey,
        }),
    );

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

    const intent = await withRateLimit(
      deps.db,
      { kind: 'deposit_create', ...rateSubjects(request) },
      () =>
        createDepositIntent(
          deps.db,
          { provider: deps.depixProvider },
          {
            userId,
            amountBrlCents: amount.amount,
            destinationAddress: body.destinationAddress!,
          },
        ),
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
    const session = sessionOf(request);
    const { userId } = session;
    const body = request.body as { amount?: string; destinationAddress?: string };

    if (!body.destinationAddress) {
      throw new DomainError('missing_address', 'Informe o endereço de destino');
    }
    const amountBrl = parseUserAmount(String(body.amount ?? ''), 'BRL');
    const amountDepix = rescale(amountBrl, 'DEPIX');

    // Política de segurança ANTES de reservar saldo: um envio que vai ser
    // recusado não deve deixar o valor preso em pending_out.
    //
    // O contato entra aqui porque é ele que carrega `updatedAt`: enviar valor
    // alto para um contato cujo endereço mudou nas últimas 24 h exige
    // confirmação. Sem esta consulta a regra existiria e nunca dispararia.
    const contato = await findContactByDestination(deps.db, userId, body.destinationAddress);
    const decision = await evaluateSendPolicy(deps.db, {
      userId,
      destination: body.destinationAddress,
      totalAmount: amountDepix,
      deviceTrusted: await isDeviceTrusted(deps.db, userId, session.deviceId),
      contactUpdatedAt: contato?.updatedAt ?? null,
    });
    enforcePolicy(decision, session, { reauthAvailable: REAUTH_AVAILABLE });

    const review = await withRateLimit(
      deps.db,
      { kind: 'send_prepare', ...rateSubjects(request) },
      () =>
        prepareDepixSend(deps.db, {
          userId,
          destinationAddress: body.destinationAddress!,
          amount: amountDepix,
        }),
    );

    const toBrl = (v: bigint) => formatBRL(rescale(money('DEPIX', v), 'BRL', 'floor'));

    return reply.status(201).send({
      transactionId: review.transactionId,
      destination: review.destination,
      network: 'Liquid Network',
      amount: toBrl(review.breakdown.principal.amount),
      fee: toBrl(review.breakdown.totalFee.amount),
      total: toBrl(review.breakdown.totalDebit.amount),
      remainingAfter: toBrl(review.remainingAfter.amount),
      // Quanto vai para o destinatário na cadeia, em unidades mínimas de
      // DePix. O dispositivo precisa deste número para montar a transação —
      // e o confere contra o próprio cálculo antes de assinar, porque quem
      // assina não deve aceitar o valor de quem não assina.
      //
      // String, não número: em JSON, inteiro grande em `number` perde
      // precisão silenciosamente.
      amountUnits: review.breakdown.principal.amount.toString(),
      assetId: DEPIX_LIQUID_ASSET_ID,
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

    // Contabiliza o uso do contato — só depois de a transação existir na
    // rede, nunca no preparo, que pode ser abandonado.
    if (transaction.counterparty) {
      await markContactUsed(deps.db, userId, transaction.counterparty);
    }

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
    const validation = await withRateLimit(
      deps.db,
      { kind: 'pix_key_preview', ...rateSubjects(request) },
      () => pix.validatePixKey(body.pixKey!),
    );

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

  // --- Contatos (§29) -------------------------------------------------------
  app.get('/contacts', authed, async (request) => {
    const { userId } = sessionOf(request);
    return { contacts: (await listContacts(deps.db, userId)).map(toApiContact) };
  });

  app.post('/contacts', authed, async (request, reply) => {
    const { userId } = sessionOf(request);
    const body = request.body as { label?: string; destination?: string; kind?: string };

    const contato = await saveContact(deps.db, {
      userId,
      label: String(body.label ?? ''),
      destination: String(body.destination ?? ''),
      kind: body.kind === 'pix_key' ? 'pix_key' : 'liquid_address',
    });

    return reply.status(201).send(toApiContact(contato));
  });

  /**
   * Trocar o endereço de um contato é operação sensível: exige confirmação
   * recente, porque é o passo do ataque em que alguém com a sessão redireciona
   * pagamentos futuros e conta com a vítima conferindo só o nome.
   */
  app.post('/contacts/:id/destination', authed, async (request) => {
    const session = sessionOf(request);
    const { id } = request.params as { id: string };
    const body = request.body as { destination?: string };

    enforcePolicy(
      { requiresReauth: true, reasons: ['recently_changed_contact'], explanation: 'Alterar o endereço de um contato exige confirmação de identidade.' },
      session,
      { reauthAvailable: REAUTH_AVAILABLE },
    );

    const contato = await changeContactDestination(deps.db, {
      userId: session.userId,
      contactId: id,
      newDestination: String(body.destination ?? ''),
    });

    return toApiContact(contato);
  });

  app.delete('/contacts/:id', authed, async (request) => {
    const { userId } = sessionOf(request);
    const { id } = request.params as { id: string };
    await deleteContact(deps.db, userId, id);
    return { removed: true };
  });

  // --- Notificações (§30) ---------------------------------------------------
  app.get('/notifications', authed, async (request) => {
    const { userId } = sessionOf(request);
    const [items, unread] = await Promise.all([
      listNotifications(deps.db, userId),
      unreadCount(deps.db, userId),
    ]);
    return {
      unread,
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        transactionId: n.transactionId,
        read: n.read,
        createdAt: toIsoString(n.createdAt),
      })),
    };
  });

  app.post('/notifications/:id/read', authed, async (request) => {
    const { userId } = sessionOf(request);
    const { id } = request.params as { id: string };
    return { read: await markRead(deps.db, userId, id) };
  });

  app.post('/notifications/read-all', authed, async (request) => {
    const { userId } = sessionOf(request);
    return { marked: await markAllRead(deps.db, userId) };
  });

  // --- Painel administrativo (§24-25) ---------------------------------------
  //
  // Toda rota daqui para baixo passa por `assertAdmin`, e toda ação exige
  // motivo — `writeAuditLog` recusa ação administrativa sem ele. Não há rota
  // para promover alguém a admin: o primeiro nasce por script de operação,
  // porque uma rota dessas é o alvo que um atacante com sessão procura.

  /** `auditor` lê; `operator` também age. */
  async function admin(request: FastifyRequest, minimo: 'auditor' | 'operator' = 'auditor') {
    const { userId } = sessionOf(request);
    return assertAdmin(deps.db, userId, minimo);
  }

  function motivoDe(request: FastifyRequest): string {
    const reason = (request.body as { reason?: string } | undefined)?.reason?.trim();
    if (!reason) {
      throw new DomainError(
        'reason_required',
        'Ação administrativa exige motivo. Sem ele a trilha de auditoria não serve para auditar.',
      );
    }
    return reason;
  }

  app.get('/admin/me', authed, async (request) => {
    const me = await admin(request);
    return { userId: me.userId, role: me.role };
  });

  app.get('/admin/reconciliation', authed, async (request) => {
    await admin(request);
    const [findings, runs] = await Promise.all([
      listOpenFindings(deps.db),
      listRuns(deps.db, 20),
    ]);

    return {
      openFindings: findings.map((f) => ({
        id: f.id,
        kind: f.kind,
        transactionId: f.transactionId,
        expected: f.expected,
        observed: f.observed,
        createdAt: toIsoString(f.createdAt),
      })),
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        findings: r.findings,
        accountsChecked: asPlainNumber(r.accountsChecked),
        transactionsChecked: asPlainNumber(r.transactionsChecked),
        startedAt: toIsoString(r.startedAt),
        finishedAt: r.finishedAt ? toIsoString(r.finishedAt) : null,
        error: r.error,
      })),
    };
  });

  app.post('/admin/reconciliation/run', authed, async (request) => {
    await admin(request, 'operator');
    const resultado = await runReconciliation(deps.db, { trigger: 'manual' });
    return {
      runId: resultado.runId,
      clean: resultado.clean,
      findings: resultado.findings,
      accountsChecked: resultado.accountsChecked,
      transactionsChecked: resultado.transactionsChecked,
    };
  });

  app.post('/admin/reconciliation/:id/resolve', authed, async (request) => {
    const me = await admin(request, 'operator');
    const { id } = request.params as { id: string };
    const body = request.body as { note?: string; status?: 'resolved' | 'reconciled' };

    await resolveFinding(deps.db, {
      id,
      adminId: me.userId,
      note: String(body.note ?? ''),
      ...(body.status ? { status: body.status } : {}),
    });

    await writeAuditLog(deps.db, {
      actorKind: 'admin',
      actorId: me.userId,
      action: 'reconciliation.resolved',
      objectKind: 'reconciliation_entry',
      objectId: id,
      reason: String(body.note ?? ''),
    });

    return { resolved: true };
  });

  app.get('/admin/review', authed, async (request) => {
    await admin(request);
    const items = await listForReview(deps.db);
    return {
      items: items.map((t) => ({
        ...t,
        createdAt: toIsoString(t.createdAt),
        updatedAt: toIsoString(t.updatedAt),
      })),
    };
  });

  app.get('/admin/users/:id', authed, async (request) => {
    await admin(request);
    const { id } = request.params as { id: string };
    const resumo = await adminUserSummary(deps.db, id);
    if (!resumo) throw new DomainError('user_not_found', 'Usuário não encontrado');
    return { ...resumo, createdAt: toIsoString(resumo.createdAt) };
  });

  app.post('/admin/users/:id/status', authed, async (request) => {
    const me = await admin(request, 'operator');
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = body.status;

    if (status !== 'active' && status !== 'suspended' && status !== 'closed') {
      throw new DomainError('invalid_status', 'Status deve ser active, suspended ou closed');
    }

    await setUserStatus(deps.db, {
      userId: id,
      status,
      adminId: me.userId,
      reason: motivoDe(request),
    });

    return { userId: id, status };
  });

  app.get('/admin/audit', authed, async (request) => {
    await admin(request);
    const query = request.query as { objectId?: string; actorId?: string };
    const logs = await listAuditLogs(deps.db, {
      ...(query.objectId ? { objectId: query.objectId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
    });

    return {
      items: logs.map((l) => ({
        id: l.id,
        actorKind: l.actorKind,
        actorId: l.actorId,
        action: l.action,
        objectKind: l.objectKind,
        objectId: l.objectId,
        reason: l.reason,
        metadata: l.metadata,
        createdAt: toIsoString(l.createdAt),
      })),
    };
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

function toApiContact(contact: Contact): Record<string, unknown> {
  return {
    id: contact.id,
    label: contact.label,
    kind: contact.kind,
    destination: contact.destination,
    timesUsed: contact.timesUsed,
    lastUsedAt: contact.lastUsedAt ? toIsoString(contact.lastUsedAt) : null,
    updatedAt: toIsoString(contact.updatedAt),
  };
}

/**
 * Data para JSON.
 *
 * O Firestore devolve `Timestamp`, não `Date`, quando o documento vem de uma
 * leitura crua. Chamar `.toISOString()` direto funciona no caminho em que o
 * objeto foi construído em memória e explode no outro — este helper cobre os
 * dois.
 */
function toIsoString(value: Date | { toDate?: () => Date }): string {
  if (value instanceof Date) return value.toISOString();
  const asDate = value?.toDate?.();
  if (asDate) return asDate.toISOString();
  return new Date(value as unknown as string).toISOString();
}

/**
 * `useBigInt` faz todo inteiro voltar como `bigint`, inclusive contadores.
 * `JSON.stringify` lança em bigint, então contador que atravessa HTTP passa
 * por aqui.
 */
function asPlainNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  insufficient_funds: 422,
  invalid_amount: 400,
  invalid_idempotency_key: 400,
  rate_limited: 429,
  reauth_required: 403,
  invalid_credentials: 401,
  account_suspended: 403,
  identifier_taken: 409,
  weak_password: 400,
  common_password: 400,
  password_too_long: 400,
  invalid_identifier: 400,
  missing_credentials: 400,
  no_password_set: 409,
  same_password: 400,
  not_admin: 403,
  insufficient_role: 403,
  reason_required: 400,
  audit_reason_required: 400,
  resolution_note_required: 400,
  sensitive_field_in_audit: 400,
  contact_not_found: 404,
  contact_conflict: 409,
  finding_not_found: 404,
  user_not_found: 404,
  invalid_status: 400,
  missing_label: 400,
  label_too_long: 400,
  missing_destination: 400,
  limit_exceeded: 422,
  transaction_not_found: 404,
  unknown_ledger_account: 404,
  invalid_transition: 409,
  challenge_invalid: 400,
  credential_not_found: 404,
  counter_regression: 403,
  authentication_failed: 401,
  registration_failed: 400,
  credential_already_registered: 409,
  last_credential: 409,
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

function sessionOf(request: FastifyRequest): SessionRecord {
  const session = (request as FastifyRequest & { session?: SessionRecord }).session;
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
