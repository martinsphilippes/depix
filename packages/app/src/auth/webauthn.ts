/**
 * Autenticação por passkey (WebAuthn).
 *
 * Escolhido como método primário por três razões que importam neste sistema:
 * é resistente a phishing (a assinatura é ligada à origem, então um site
 * clonado não consegue usá-la), não deixa segredo compartilhado no servidor
 * (guardamos chave pública), e **não exige identidade** — o `userID` do
 * WebAuthn é um identificador aleatório nosso, o que sustenta a conta
 * pseudônima pedida na seção 18.7 dos requisitos.
 *
 * Três propriedades que este módulo precisa entregar, e que são exatamente
 * onde implementações de WebAuthn costumam errar:
 *
 *  1. **Challenge de uso único, guardado pelo servidor.** Um challenge
 *     reutilizável derruba a garantia inteira: um atacante que capture uma
 *     assinatura poderia reapresentá-la. O consumo é feito em transação, e
 *     acontece mesmo quando a verificação falha depois — repetir uma
 *     tentativa exige challenge novo.
 *
 *  2. **Contador anti-clone.** O autenticador incrementa um contador a cada
 *     assinatura. Se ele voltar atrás, há duas cópias da credencial em
 *     circulação — sinal de clonagem, e motivo para recusar.
 *
 *  3. **Origem e RP ID conferidos.** Errar isso é abrir a porta para
 *     phishing, que é justamente o que a passkey deveria fechar.
 */

import { randomBytes } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { DomainError } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type UserDoc,
  type WebAuthnChallengeDoc,
  type WebAuthnCredentialDoc,
  asNumber,
  createUserLedgerAccounts,
  isAlreadyExists,
  toDate,
} from '@depix/firestore';

import { writeAuditLog } from '../services/audit.ts';

export interface WebAuthnConfig {
  /** Nome exibido no diálogo do sistema. */
  readonly rpName: string;
  /** Domínio, sem esquema nem porta. Ex.: "carteira.exemplo.br". */
  readonly rpID: string;
  /** Origem completa esperada. Ex.: "https://carteira.exemplo.br". */
  readonly origin: string | string[];
}

export type ChallengePurpose = 'registration' | 'authentication' | 'reauth';

/**
 * Transportes definidos pela especificação.
 *
 * O que vem do banco é `string[]`; filtrar contra esta lista impede que um
 * valor desconhecido — gravado por uma versão futura, ou adulterado — seja
 * repassado ao verificador.
 */
const KNOWN_TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
type KnownTransport = (typeof KNOWN_TRANSPORTS)[number];

/**
 * Lê o contador de assinaturas do `authenticatorData`.
 *
 * Layout fixado pela especificação (WebAuthn §6.1):
 *   rpIdHash(32) || flags(1) || signCount(4, big-endian) || …
 *
 * Precisamos dele **antes** da verificação: a biblioteca também recusa
 * contador que regride, mas com erro genérico. Detectar aqui permite devolver
 * um código próprio e registrar em auditoria — regressão de contador é sinal
 * de credencial clonada, e isso é achado de segurança, não erro de digitação.
 */
function readSignCount(authenticatorDataB64Url: string): number | null {
  const bytes = Buffer.from(authenticatorDataB64Url, 'base64url');
  if (bytes.length < 37) return null;
  return bytes.readUInt32BE(33);
}

function toTransports(values: readonly string[]): KnownTransport[] {
  return values.filter((v): v is KnownTransport =>
    (KNOWN_TRANSPORTS as readonly string[]).includes(v),
  );
}

/** Janela do challenge. Curta de propósito: reduz a superfície de replay. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class WebAuthnError extends DomainError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'WebAuthnError';
  }
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

async function storeChallenge(
  db: Db,
  params: {
    challenge: string;
    purpose: ChallengePurpose;
    userId: string | null;
    sessionId?: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = params.now ?? new Date();
  const doc: WebAuthnChallengeDoc = {
    challenge: params.challenge,
    purpose: params.purpose,
    userId: params.userId,
    sessionId: params.sessionId ?? null,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    createdAt: now,
  };

  // O ID do documento é o próprio challenge: `create` garante que o mesmo
  // valor não exista duas vezes.
  await db
    .doc(`${COLLECTIONS.webauthnChallenges}/${encodeURIComponent(params.challenge)}`)
    .create(doc as unknown as Record<string, unknown>)
    .catch((err: unknown) => {
      if (isAlreadyExists(err)) {
        throw new WebAuthnError('challenge_collision', 'Challenge repetido; tente novamente');
      }
      throw err;
    });
}

/**
 * Consome um challenge: lê e apaga na mesma transação.
 *
 * Apagar antes de verificar a assinatura é deliberado. Se o consumo só
 * acontecesse no sucesso, um atacante poderia tentar a mesma assinatura
 * repetidamente. Aqui, cada tentativa gasta o challenge.
 */
async function consumeChallenge(
  db: Db,
  challenge: string,
  purpose: ChallengePurpose,
  now: Date = new Date(),
): Promise<WebAuthnChallengeDoc | null> {
  const ref = db.doc(`${COLLECTIONS.webauthnChallenges}/${encodeURIComponent(challenge)}`);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get<WebAuthnChallengeDoc>(ref);
    if (!doc) return null;

    tx.delete(ref);

    if (doc.purpose !== purpose) return null;
    if (toDate(doc.expiresAt).getTime() <= now.getTime()) return null;

    return doc;
  });
}

/** Higiene: challenges expirados não têm valor e acumulam. */
export async function pruneExpiredChallenges(db: Db, now: Date = new Date()): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.webauthnChallenges)
    .where('expiresAt', '<', now)
    .limit(500)
    .get();

  if (snap.empty) return 0;
  const batch = db.fs.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export interface RegistrationStart {
  readonly options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  readonly userId: string;
}

/**
 * Inicia o registro de uma passkey.
 *
 * Cria a conta pseudônima quando não há usuário ainda: o `userID` do WebAuthn
 * é aleatório e o `userName` é um apelido gerado. Nenhum dado pessoal é
 * pedido — nem e-mail, que continua opcional e só para recuperação.
 */
export async function startPasskeyRegistration(
  db: Db,
  params: { config: WebAuthnConfig; userId?: string; handle?: string },
): Promise<RegistrationStart> {
  let userId = params.userId;
  let handle = params.handle;

  if (!userId) {
    const ref = db.collection(COLLECTIONS.users).doc();
    userId = ref.id;
    handle = handle ?? `conta-${userId.slice(0, 6).toLowerCase()}`;

    const user: UserDoc = {
      handle,
      email: null,
      emailVerified: false,
      status: 'active',
      advancedMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await ref.create(user as unknown as Record<string, unknown>);

    // Contas contábeis do usuário, criadas junto com a conta.
    //
    // ⚠️ Isto faltava, e o buraco era sério: sem as contas, o primeiro
    // crédito — um Pix confirmado — lançava `unknown_ledger_account` e o
    // dinheiro do usuário não entrava. Nenhum teste pegou porque **todos**
    // usam `seedUser`, que criava as contas por fora; a suíte inteira estava
    // construída sobre um atalho que o caminho real não tem.
    //
    // Encontrado ao percorrer o cadastro de verdade num navegador.
    await createUserLedgerAccounts(db, userId);
  } else {
    const snap = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
    if (!snap.exists) throw new WebAuthnError('user_not_found', 'Conta não encontrada');
    handle = handle ?? ((snap.data() as UserDoc).handle ?? 'conta');
  }

  // Impede registrar duas vezes o mesmo autenticador nesta conta.
  const existentes = await listCredentials(db, userId);

  const options = await generateRegistrationOptions({
    rpName: params.config.rpName,
    rpID: params.config.rpID,
    userName: handle,
    userDisplayName: handle,
    // Identificador opaco e aleatório: não deriva de e-mail nem de documento.
    userID: new Uint8Array(randomBytes(32)),
    attestationType: 'none', // atestado revelaria o modelo do autenticador
    excludeCredentials: existentes.map((c) => {
      const transports = toTransports(c.transports);
      return { id: c.credentialId, ...(transports.length > 0 ? { transports } : {}) };
    }),
    authenticatorSelection: {
      // Credencial descobrível permite login sem digitar identificador —
      // o que sustenta a conta pseudônima.
      residentKey: 'preferred',
      // Exige biometria/PIN: é o que diferencia "alguém tocou" de
      // "o dono aprovou", e num app financeiro essa diferença é o controle.
      userVerification: 'required',
    },
  });

  await storeChallenge(db, {
    challenge: options.challenge,
    purpose: 'registration',
    userId,
  });

  return { options, userId };
}

export interface RegistrationResult {
  readonly userId: string;
  readonly credentialId: string;
  readonly backedUp: boolean;
}

/**
 * Conclui o registro.
 *
 * Não recebe `userId` do cliente: ele vem do challenge guardado no servidor.
 * Aceitar um `userId` enviado pelo cliente permitiria anexar uma passkey à
 * conta de outra pessoa.
 */
export async function finishPasskeyRegistration(
  db: Db,
  params: { config: WebAuthnConfig; response: Parameters<typeof verifyRegistrationResponse>[0]['response']; label?: string },
): Promise<RegistrationResult> {
  let challengeDoc: WebAuthnChallengeDoc | null = null;

  const verification = await verifyRegistrationResponse({
    response: params.response,
    expectedChallenge: async (challenge: string) => {
      challengeDoc = await consumeChallenge(db, challenge, 'registration');
      return challengeDoc !== null;
    },
    expectedOrigin: params.config.origin,
    expectedRPID: params.config.rpID,
    requireUserVerification: true,
  }).catch((err: unknown) => {
    throw new WebAuthnError('registration_failed', `Não foi possível registrar a passkey: ${String(err).slice(0, 140)}`);
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new WebAuthnError('registration_failed', 'A passkey não pôde ser verificada');
  }
  const stored = challengeDoc as WebAuthnChallengeDoc | null;
  if (!stored?.userId) {
    throw new WebAuthnError('challenge_invalid', 'Challenge inválido, expirado ou já usado');
  }

  const info = verification.registrationInfo;
  const credential = info.credential;

  const doc: WebAuthnCredentialDoc = {
    userId: stored.userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    label: params.label ?? null,
    createdAt: new Date(),
    lastUsedAt: null,
  };

  // ID do documento = ID da credencial: a mesma passkey não é registrada duas
  // vezes, nem nesta conta nem em outra.
  await db
    .doc(`${COLLECTIONS.webauthnCredentials}/${encodeURIComponent(credential.id)}`)
    .create(doc as unknown as Record<string, unknown>)
    .catch((err: unknown) => {
      if (isAlreadyExists(err)) {
        throw new WebAuthnError('credential_already_registered', 'Esta passkey já está registrada');
      }
      throw err;
    });

  return {
    userId: stored.userId,
    credentialId: credential.id,
    backedUp: info.credentialBackedUp,
  };
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

export interface AuthenticationStart {
  readonly options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}

/**
 * Inicia login ou reautenticação.
 *
 * Sem `userId`, o fluxo é sem identificador: o autenticador oferece as
 * credenciais que conhece para este domínio. É a forma que não exige o
 * usuário digitar nada que o identifique.
 */
export async function startPasskeyAuthentication(
  db: Db,
  params: {
    config: WebAuthnConfig;
    purpose?: ChallengePurpose;
    userId?: string;
    sessionId?: string;
  },
): Promise<AuthenticationStart> {
  const purpose = params.purpose ?? 'authentication';
  const allow = params.userId ? await listCredentials(db, params.userId) : [];

  const options = await generateAuthenticationOptions({
    rpID: params.config.rpID,
    userVerification: 'required',
    ...(allow.length > 0
      ? {
          allowCredentials: allow.map((c) => {
            const transports = toTransports(c.transports);
            return { id: c.credentialId, ...(transports.length > 0 ? { transports } : {}) };
          }),
        }
      : {}),
  });

  await storeChallenge(db, {
    challenge: options.challenge,
    purpose,
    userId: params.userId ?? null,
    sessionId: params.sessionId ?? null,
  });

  return { options };
}

export interface AuthenticationResult {
  readonly userId: string;
  readonly credentialId: string;
  readonly sessionId: string | null;
}

/**
 * Conclui login ou reautenticação.
 *
 * O contador é a defesa contra credencial clonada: se voltar atrás, há duas
 * cópias em circulação. Nesse caso recusamos **e** registramos — é sinal de
 * comprometimento, não de erro do usuário.
 */
export async function finishPasskeyAuthentication(
  db: Db,
  params: {
    config: WebAuthnConfig;
    response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
    purpose?: ChallengePurpose;
  },
): Promise<AuthenticationResult> {
  const purpose = params.purpose ?? 'authentication';

  const credentialId = params.response.id;
  const credRef = db.doc(`${COLLECTIONS.webauthnCredentials}/${encodeURIComponent(credentialId)}`);
  const credSnap = await credRef.get();
  if (!credSnap.exists) {
    throw new WebAuthnError('credential_not_found', 'Passkey não reconhecida');
  }
  const stored = credSnap.data() as WebAuthnCredentialDoc;
  const storedCounter = asNumber(stored.counter, 'counter');

  // Regressão de contador é checada antes da verificação criptográfica para
  // que o motivo da recusa seja específico e fique auditado.
  const presentedCounter = readSignCount(
    (params.response as { response: { authenticatorData: string } }).response.authenticatorData,
  );
  if (
    presentedCounter !== null &&
    (presentedCounter > 0 || storedCounter > 0) &&
    presentedCounter <= storedCounter
  ) {
    await recordCounterRegression(db, { credentialId, storedCounter, newCounter: presentedCounter });
    throw new WebAuthnError(
      'counter_regression',
      'Esta passkey apresentou um contador inconsistente e foi recusada por segurança.',
      { credentialId },
    );
  }

  let challengeDoc: WebAuthnChallengeDoc | null = null;

  const verification = await verifyAuthenticationResponse({
    response: params.response,
    expectedChallenge: async (challenge: string) => {
      challengeDoc = await consumeChallenge(db, challenge, purpose);
      return challengeDoc !== null;
    },
    expectedOrigin: params.config.origin,
    expectedRPID: params.config.rpID,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: storedCounter,
      ...(toTransports(stored.transports).length > 0
        ? { transports: toTransports(stored.transports) }
        : {}),
    },
  }).catch((err: unknown) => {
    throw new WebAuthnError('authentication_failed', `Não foi possível verificar a passkey: ${String(err).slice(0, 140)}`);
  });

  if (!verification.verified) {
    throw new WebAuthnError('authentication_failed', 'A passkey não pôde ser verificada');
  }

  const challenge = challengeDoc as WebAuthnChallengeDoc | null;
  if (!challenge) {
    throw new WebAuthnError('challenge_invalid', 'Challenge inválido, expirado ou já usado');
  }
  // Numa reautenticação o challenge está amarrado a um usuário; a credencial
  // apresentada precisa ser dele.
  if (challenge.userId && challenge.userId !== stored.userId) {
    throw new WebAuthnError('credential_user_mismatch', 'Esta passkey não pertence a esta conta');
  }

  await credRef.update({
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: new Date(),
  });

  return {
    userId: stored.userId,
    credentialId,
    sessionId: challenge.sessionId,
  };
}

// ---------------------------------------------------------------------------

export interface CredentialSummary {
  readonly credentialId: string;
  readonly transports: string[];
  readonly label: string | null;
  readonly backedUp: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export async function listCredentials(db: Db, userId: string): Promise<CredentialSummary[]> {
  const snap = await db
    .collection(COLLECTIONS.webauthnCredentials)
    .where('userId', '==', userId)
    .get();

  return snap.docs.map((d) => {
    const doc = d.data() as WebAuthnCredentialDoc;
    return {
      credentialId: doc.credentialId,
      transports: doc.transports,
      label: doc.label,
      backedUp: doc.backedUp,
      createdAt: toDate(doc.createdAt),
      lastUsedAt: doc.lastUsedAt ? toDate(doc.lastUsedAt) : null,
    };
  });
}

/**
 * Remove uma passkey.
 *
 * Recusa remover a última: uma conta sem credencial fica inacessível, e
 * "removi sem querer e perdi o acesso" é um jeito ruim de descobrir isso.
 */
export async function removeCredential(
  db: Db,
  params: { userId: string; credentialId: string },
): Promise<void> {
  const restantes = await listCredentials(db, params.userId);
  if (restantes.length <= 1) {
    throw new WebAuthnError(
      'last_credential',
      'Esta é a sua única passkey. Cadastre outra antes de remover esta, ou você perderá o acesso à conta.',
    );
  }

  const ref = db.doc(`${COLLECTIONS.webauthnCredentials}/${encodeURIComponent(params.credentialId)}`);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as WebAuthnCredentialDoc).userId !== params.userId) {
    throw new WebAuthnError('credential_not_found', 'Passkey não encontrada nesta conta');
  }

  await ref.delete();
}

export async function hasCredentials(db: Db, userId: string): Promise<boolean> {
  const snap = await db
    .collection(COLLECTIONS.webauthnCredentials)
    .where('userId', '==', userId)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Registra a suspeita de clonagem.
 *
 * Alguns autenticadores mantêm o contador sempre em zero e não implementam a
 * proteção — por isso a checagem só vale quando algum dos dois lados já
 * avançou. Recusar o zero constante seria recusar hardware legítimo.
 */
async function recordCounterRegression(
  db: Db,
  params: { credentialId: string; storedCounter: number; newCounter: number },
): Promise<void> {
  await writeAuditLog(db, {
    actorKind: 'system',
    action: 'webauthn.counter_regression',
    objectKind: 'credential',
    objectId: params.credentialId,
    reason: 'contador não avançou — possível credencial clonada',
    metadata: {
      storedCounter: String(params.storedCounter),
      newCounter: String(params.newCounter),
    },
  });
}

