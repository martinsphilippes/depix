/**
 * Política de segurança: quando exigir confirmação de identidade.
 *
 * Ter uma sessão válida não basta para tudo. Uma sessão roubada é o cenário
 * exato em que o atacante já passou pela porta — o que ainda pode proteger o
 * usuário é exigir uma prova recente de identidade nas operações que
 * importam.
 *
 * Decisão e satisfação são separadas de propósito. A decisão vive aqui; a
 * satisfação é a cerimônia WebAuthn (`auth/webauthn.ts`), que carimba
 * `reauthAt` na sessão. `enforcePolicy` recebe `reauthAvailable` para saber
 * qual das duas coisas está acontecendo quando bloqueia:
 *
 *   • com a cerimônia disponível, o bloqueio é um pedido — a UI manda o
 *     usuário confirmar por passkey e repete a operação;
 *   • sem ela, o bloqueio é definitivo, e a mensagem diz isso.
 *
 * O segundo caso não deve mais acontecer na API (que passa `true`), mas o
 * parâmetro fica: falhar fechado quando não há como verificar é o
 * comportamento correto de um sistema financeiro, e a alternativa — deixar
 * passar porque ainda não temos como verificar — seria um controle que existe
 * no papel e não no caminho da operação.
 */

import { type Money, DomainError, formatBRL, money, rescale } from '@depix/core';
import { COLLECTIONS, type Db, type DeviceLike, type TransactionDoc } from '@depix/firestore';

import { type SessionRecord, hasFreshReauth } from '../auth/session.ts';

/** Acima disto, envio exige confirmação de identidade recente. */
export const REAUTH_AMOUNT_THRESHOLD_CENTS = 50_000n; // R$ 500,00

export type ReauthReason =
  | 'high_value'
  | 'new_recipient'
  | 'untrusted_device'
  | 'recently_changed_contact';

export interface PolicyDecision {
  readonly requiresReauth: boolean;
  readonly reasons: readonly ReauthReason[];
  /** Texto para a UI explicar por que está pedindo confirmação. */
  readonly explanation: string | null;
}

const REASON_TEXT: Record<ReauthReason, string> = {
  high_value: 'o valor está acima do limite que dispensa confirmação',
  new_recipient: 'é a primeira vez que você envia para este destino',
  untrusted_device: 'este dispositivo ainda não é reconhecido',
  recently_changed_contact: 'este contato foi alterado recentemente',
};

export interface EvaluateParams {
  readonly userId: string;
  readonly destination: string;
  readonly totalAmount: Money;
  readonly deviceTrusted?: boolean;
  readonly contactUpdatedAt?: Date | null;
  readonly now?: Date;
}

/**
 * Decide se a operação exige confirmação de identidade.
 *
 * Acumula todos os motivos em vez de parar no primeiro: a UI explica melhor
 * "valor alto e destino novo" do que só um dos dois.
 */
export async function evaluateSendPolicy(db: Db, params: EvaluateParams): Promise<PolicyDecision> {
  const reasons: ReauthReason[] = [];

  const cents =
    params.totalAmount.asset === 'BRL'
      ? params.totalAmount.amount
      : rescale(params.totalAmount, 'BRL', 'floor').amount;

  if (cents > REAUTH_AMOUNT_THRESHOLD_CENTS) {
    reasons.push('high_value');
  }

  if (await isNewRecipient(db, params.userId, params.destination)) {
    reasons.push('new_recipient');
  }

  if (params.deviceTrusted === false) {
    reasons.push('untrusted_device');
  }

  // Contato alterado há pouco: defesa contra troca de endereço por quem já
  // tem a sessão. Trocar o endereço de um contato e mandar em seguida é o
  // roteiro do ataque (SECURITY.md §8).
  if (params.contactUpdatedAt) {
    const idade = (params.now ?? new Date()).getTime() - params.contactUpdatedAt.getTime();
    if (idade < RECENT_CONTACT_CHANGE_MS) reasons.push('recently_changed_contact');
  }

  return {
    requiresReauth: reasons.length > 0,
    reasons,
    explanation:
      reasons.length === 0
        ? null
        : `Confirmação necessária porque ${reasons.map((r) => REASON_TEXT[r]).join(' e ')}.`,
  };
}

const RECENT_CONTACT_CHANGE_MS = 24 * 60 * 60 * 1000;

/**
 * Destino inédito para este usuário.
 *
 * Consulta transações anteriores em qualquer estado, não só concluídas: um
 * envio que falhou ainda demonstra que o usuário já conhecia aquele destino.
 */
export async function isNewRecipient(
  db: Db,
  userId: string,
  destination: string,
): Promise<boolean> {
  const snap = await db
    .collection(COLLECTIONS.transactions)
    .where('userId', '==', userId)
    .where('counterparty', '==', destination)
    .limit(1)
    .get();

  return snap.empty;
}

export class ReauthRequiredError extends DomainError {
  constructor(decision: PolicyDecision, satisfiable: boolean) {
    super(
      'reauth_required',
      satisfiable
        ? (decision.explanation ?? 'Esta operação exige confirmação de identidade.')
        : `${decision.explanation ?? 'Esta operação exige confirmação de identidade.'} ` +
          'A confirmação por passkey ainda não está disponível nesta versão, ' +
          'então a operação está bloqueada.',
      {
        reasons: decision.reasons,
        satisfiable,
      },
    );
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Aplica a decisão sobre uma sessão.
 *
 * `reauthAvailable` reflete se existe mecanismo para o usuário se
 * reautenticar. Enquanto for `false`, a operação é bloqueada em vez de
 * liberada — falhar fechado.
 */
export function enforcePolicy(
  decision: PolicyDecision,
  session: SessionRecord,
  opts: { reauthAvailable: boolean; now?: Date },
): void {
  if (!decision.requiresReauth) return;
  if (hasFreshReauth(session, opts.now)) return;

  throw new ReauthRequiredError(decision, opts.reauthAvailable);
}

/** Marca um dispositivo como confiável. Exige confirmação recente. */
export async function trustDevice(
  db: Db,
  params: { userId: string; deviceId: string; session: SessionRecord },
): Promise<void> {
  if (!hasFreshReauth(params.session)) {
    throw new DomainError(
      'reauth_required',
      'Confirmar um dispositivo exige confirmação de identidade recente',
    );
  }

  await db
    .doc(`${COLLECTIONS.users}/${params.userId}/devices/${params.deviceId}`)
    .set({ trustedAt: new Date() }, { merge: true });
}

export async function isDeviceTrusted(
  db: Db,
  userId: string,
  deviceId: string | null,
): Promise<boolean> {
  if (!deviceId) return false;
  const snap = await db.doc(`${COLLECTIONS.users}/${userId}/devices/${deviceId}`).get();
  if (!snap.exists) return false;
  return (snap.data() as DeviceLike).trustedAt != null;
}

/** Texto de limite para a UI. */
export function reauthThresholdLabel(): string {
  return formatBRL(money('BRL', REAUTH_AMOUNT_THRESHOLD_CENTS));
}
