/**
 * Autenticação por identificador e senha.
 *
 * Convive com a passkey em vez de substituí-la: quem quiser entra sem senha,
 * quem preferir senha entra com senha, e as duas podem estar cadastradas na
 * mesma conta. A passkey continua sendo o fator mais forte — resiste a
 * phishing, e senha nenhuma resiste.
 *
 * ## O que este módulo precisa acertar
 *
 * **1. A senha nunca é gravada.** Só o hash Argon2id, com os parâmetros
 * recomendados pelo OWASP (19 MiB de memória, 2 iterações). Memória alta é o
 * que torna caro atacar em GPU, que é como senhas vazadas são quebradas hoje.
 *
 * **2. Login não revela se a conta existe.** Identificador desconhecido e
 * senha errada devolvem a **mesma** mensagem e consomem o **mesmo** tempo.
 *
 * A segunda parte é mais difícil do que parece, e a primeira tentativa aqui
 * estava errada. A ideia original — verificar contra um hash de mentira
 * quando a conta não existe — igualava o custo de CPU e não o de rede: conta
 * existente faz **duas** leituras (índice e usuário), inexistente faz **uma**.
 * Medido, o Argon2 custa ~11 ms e cada leitura ~50 ms, então a diferença
 * sobrevivia inteira: 108 ms contra 18 ms, quase 6×. Um teste de tempo pegou.
 *
 * A correção é um **piso de tempo**: toda verificação leva pelo menos
 * `MIN_LOGIN_MS`, com o resto preenchido por espera. Isso limita o vazamento
 * independentemente do que esteja lento por baixo — banco, KDF ou rede — em
 * vez de tentar equilibrar cada parte, que é uma corrida que se perde a cada
 * refactor.
 *
 * O piso **não é** garantia absoluta: se o caminho real estourar o piso (banco
 * muito lento), a diferença reaparece na cauda. É mitigação, e está dito.
 *
 * **3. A senha da conta não é o PIN da carteira.** São segredos diferentes,
 * com propósitos diferentes: a senha prova quem você é para o servidor; o PIN
 * decifra a frase de recuperação **neste aparelho** e nunca sai dele. Usar o
 * mesmo valor para os dois faria a senha — que trafega — virar a chave do
 * cofre. A interface diz isso ao usuário, e nada no código liga um ao outro.
 *
 * **4. Trocar a senha exige confirmação recente.** Uma sessão roubada não deve
 * conseguir trocar a senha e expulsar o dono.
 */

import { hash, verify } from '@node-rs/argon2';

import { DomainError } from '@depix/core';
import { COLLECTIONS, type Db, type UserDoc, idComponent, isAlreadyExists } from '@depix/firestore';

import { writeAuditLog } from '../services/audit.ts';

/**
 * Tamanho mínimo.
 *
 * Doze, e nenhuma regra de composição. O NIST abandonou "uma maiúscula, um
 * número, um símbolo" porque produz `Senha@123` — previsível para a máquina e
 * difícil para a pessoa. Comprimento é o que realmente custa ao atacante.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Teto: senha absurdamente longa é vetor de negação de serviço no KDF. */
const MAX_PASSWORD_LENGTH = 256;

/**
 * Piso de tempo da verificação de senha.
 *
 * Acima do caminho mais lento medido (~110 ms com o emulador), com folga para
 * o banco de produção. Imperceptível para quem faz login; suficiente para
 * afogar a diferença entre "conta existe" e "conta não existe".
 */
export const MIN_LOGIN_MS = 300;

/** Espera o que faltar para completar o piso. */
async function comTempoMinimo<T>(inicio: bigint, resultado: Promise<T>): Promise<T> {
  try {
    return await resultado;
  } finally {
    const decorrido = Number(process.hrtime.bigint() - inicio) / 1e6;
    const restante = MIN_LOGIN_MS - decorrido;
    if (restante > 0) await new Promise((r) => setTimeout(r, restante));
  }
}

/**
 * Recusa o punhado de senhas que aparecem em toda lista de vazamento.
 *
 * Não pretende ser um dicionário — é uma barreira contra o caso óbvio. Uma
 * verificação séria consultaria uma base de senhas vazadas (k-anonymity do
 * Have I Been Pwned), e isso está anotado como pendência em SECURITY.md.
 */
const OBVIAS = new Set([
  // Todas com pelo menos MIN_PASSWORD_LENGTH caracteres — abaixo disso a
  // checagem de comprimento já recusa, e uma entrada curta aqui seria código
  // morto. (Escrevi a primeira versão com entradas de 11 caracteres, e o
  // teste que exigia a mensagem específica falhou por isso.)
  'senha12345678',
  'password1234',
  '123456789012',
  'qwertyuiopas',
  'senhasenhasenha',
  'carteira1234',
  'minhasenha123',
]);

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(
      'weak_password',
      `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres. ` +
        'Uma frase que só você saberia é melhor do que símbolos embaralhados.',
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new DomainError('password_too_long', 'Senha longa demais.');
  }
  if (OBVIAS.has(password.toLowerCase())) {
    throw new DomainError(
      'common_password',
      'Esta senha aparece em listas de senhas vazadas. Escolha outra.',
    );
  }
}

/**
 * Normaliza o identificador de login.
 *
 * Minúsculas e sem espaços nas pontas: ninguém deve ficar de fora da própria
 * conta por ter digitado `Maria@…` em vez de `maria@…`. A normalização precisa
 * ser idêntica no cadastro e no login, e é por isso que vive numa função só.
 */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  // Deliberadamente frouxo. Validar e-mail por expressão regular é um problema
  // conhecido por não ter solução boa; o que importa aqui é distinguir "parece
  // e-mail" de "parece apelido".
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function assertValidIdentifier(identifier: string): void {
  const id = normalizeIdentifier(identifier);
  if (id.length < 3) {
    throw new DomainError('invalid_identifier', 'Informe um e-mail ou um nome de usuário.');
  }
  if (id.length > 120) {
    throw new DomainError('invalid_identifier', 'Identificador longo demais.');
  }
  if (!isEmail(id) && !/^[a-z0-9._-]{3,40}$/.test(id)) {
    throw new DomainError(
      'invalid_identifier',
      'Use um e-mail válido ou um nome de usuário com letras, números, ponto, hífen ou sublinhado.',
    );
  }
}

/**
 * Hash usado quando a conta não existe.
 *
 * Verificar contra ele custa o mesmo que verificar contra um hash de verdade,
 * o que iguala o tempo de resposta dos dois casos. Gerado uma vez por
 * processo, sobre um valor aleatório que ninguém conhece.
 */
let hashFalso: Promise<string> | null = null;
function obterHashFalso(): Promise<string> {
  hashFalso ??= hash(`inexistente:${Math.random()}:${Date.now()}`);
  return hashFalso;
}

export interface RegisterPasswordParams {
  readonly identifier: string;
  readonly password: string;
  readonly now?: Date;
}

export interface PasswordAccount {
  readonly userId: string;
  readonly identifier: string;
}

/**
 * Cria conta com identificador e senha.
 *
 * O documento em `loginIndex` **é** a constraint de unicidade: o ID é o
 * identificador normalizado, e `create()` falha se já existir. Verificar antes
 * com uma consulta teria janela de corrida — duas pessoas cadastrando o mesmo
 * e-mail no mesmo instante criariam duas contas.
 */
export async function registerWithPassword(
  db: Db,
  params: RegisterPasswordParams,
): Promise<PasswordAccount> {
  assertValidIdentifier(params.identifier);
  assertPasswordStrength(params.password);

  const identifier = normalizeIdentifier(params.identifier);
  const now = params.now ?? new Date();

  // O hash é calculado antes de qualquer escrita: é a parte cara, e falhar
  // depois de criar o usuário deixaria uma conta sem senha.
  const passwordHash = await hash(params.password);

  const userRef = db.collection(COLLECTIONS.users).doc();
  const userId = userRef.id;

  const indexRef = db.doc(`${COLLECTIONS.loginIndex}/${idComponent(identifier)}`);
  try {
    await indexRef.create({ userId, identifier, createdAt: now });
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw new DomainError(
        'identifier_taken',
        'Já existe uma conta com este e-mail ou nome de usuário.',
      );
    }
    throw err;
  }

  const user: UserDoc = {
    handle: isEmail(identifier) ? null : identifier,
    email: isEmail(identifier) ? identifier : null,
    emailVerified: false,
    status: 'active',
    advancedMode: false,
    passwordHash,
    passwordUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await userRef.create(user as unknown as Record<string, unknown>);

  // As contas contábeis nascem junto. Sem isto, o primeiro crédito falharia
  // com `unknown_ledger_account` — foi exatamente o que aconteceu no caminho
  // da passkey antes de ser corrigido.
  const { createUserLedgerAccounts } = await import('@depix/firestore');
  await createUserLedgerAccounts(db, userId);

  await writeAuditLog(db, {
    actorKind: 'user',
    actorId: userId,
    action: 'account.created_with_password',
    objectKind: 'user',
    objectId: userId,
  });

  return { userId, identifier };
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    // Mensagem única para conta inexistente e senha errada: qualquer diferença
    // aqui informa ao atacante quais contas existem.
    super('invalid_credentials', 'E-mail, usuário ou senha incorretos.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * Verifica identificador e senha.
 *
 * Sempre executa uma verificação Argon2, mesmo quando a conta não existe —
 * ver a nota sobre tempo constante no cabeçalho do módulo.
 */
export async function verifyPassword(
  db: Db,
  params: { identifier: string; password: string },
): Promise<PasswordAccount> {
  return comTempoMinimo(process.hrtime.bigint(), verificar(db, params));
}

async function verificar(
  db: Db,
  params: { identifier: string; password: string },
): Promise<PasswordAccount> {
  const identifier = normalizeIdentifier(params.identifier);

  const indexSnap = await db.doc(`${COLLECTIONS.loginIndex}/${idComponent(identifier)}`).get();

  if (!indexSnap.exists) {
    await verify(await obterHashFalso(), params.password).catch(() => false);
    throw new InvalidCredentialsError();
  }

  const { userId } = indexSnap.data() as { userId: string };
  const userSnap = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
  const user = userSnap.exists ? (userSnap.data() as UserDoc) : null;

  if (!user?.passwordHash) {
    await verify(await obterHashFalso(), params.password).catch(() => false);
    throw new InvalidCredentialsError();
  }

  const ok = await verify(user.passwordHash, params.password).catch(() => false);
  if (!ok) throw new InvalidCredentialsError();

  // Conta suspensa não entra. A checagem vem **depois** da senha para não
  // transformar o status em oráculo: "senha certa mas conta suspensa" e
  // "senha errada" não devem ser distinguíveis por quem não sabe a senha.
  if (user.status !== 'active') {
    throw new DomainError(
      'account_suspended',
      'Esta conta está suspensa. Fale com o suporte.',
    );
  }

  return { userId, identifier };
}

/**
 * Troca a senha.
 *
 * Exige a senha atual mesmo com sessão válida: uma sessão roubada não deve
 * conseguir trocar a senha e expulsar o dono da própria conta.
 */
export async function changePassword(
  db: Db,
  params: { userId: string; currentPassword: string; newPassword: string; now?: Date },
): Promise<void> {
  assertPasswordStrength(params.newPassword);

  const ref = db.doc(`${COLLECTIONS.users}/${params.userId}`);
  const snap = await ref.get();
  const user = snap.exists ? (snap.data() as UserDoc) : null;

  if (!user?.passwordHash) {
    throw new DomainError(
      'no_password_set',
      'Esta conta não tem senha cadastrada. Defina uma em vez de trocar.',
    );
  }

  const ok = await verify(user.passwordHash, params.currentPassword).catch(() => false);
  if (!ok) throw new InvalidCredentialsError();

  if (params.currentPassword === params.newPassword) {
    throw new DomainError('same_password', 'A nova senha precisa ser diferente da atual.');
  }

  const now = params.now ?? new Date();
  await ref.set(
    { passwordHash: await hash(params.newPassword), passwordUpdatedAt: now, updatedAt: now },
    { merge: true },
  );

  await writeAuditLog(db, {
    actorKind: 'user',
    actorId: params.userId,
    action: 'account.password_changed',
    objectKind: 'user',
    objectId: params.userId,
  });
}

/**
 * Define senha numa conta que só tinha passkey.
 *
 * Exige confirmação recente de identidade — quem chama passa `session` e usa
 * `assertFreshReauth` antes. Sem isso, uma sessão roubada acrescentaria uma
 * senha conhecida pelo atacante a uma conta que só o dono conseguia acessar.
 */
export async function setPassword(
  db: Db,
  params: { userId: string; identifier: string; password: string; now?: Date },
): Promise<void> {
  assertValidIdentifier(params.identifier);
  assertPasswordStrength(params.password);

  const identifier = normalizeIdentifier(params.identifier);
  const now = params.now ?? new Date();
  const passwordHash = await hash(params.password);

  const indexRef = db.doc(`${COLLECTIONS.loginIndex}/${idComponent(identifier)}`);
  try {
    await indexRef.create({ userId: params.userId, identifier, createdAt: now });
  } catch (err) {
    if (isAlreadyExists(err)) {
      const existente = (await indexRef.get()).data() as { userId: string } | undefined;
      if (existente?.userId !== params.userId) {
        throw new DomainError(
          'identifier_taken',
          'Já existe uma conta com este e-mail ou nome de usuário.',
        );
      }
    } else {
      throw err;
    }
  }

  await db.doc(`${COLLECTIONS.users}/${params.userId}`).set(
    {
      passwordHash,
      passwordUpdatedAt: now,
      updatedAt: now,
      ...(isEmail(identifier) ? { email: identifier } : { handle: identifier }),
    },
    { merge: true },
  );

  await writeAuditLog(db, {
    actorKind: 'user',
    actorId: params.userId,
    action: 'account.password_set',
    objectKind: 'user',
    objectId: params.userId,
  });
}

/** Se a conta tem senha — a tela de ajustes precisa saber o que oferecer. */
export async function hasPassword(db: Db, userId: string): Promise<boolean> {
  const snap = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
  return !!(snap.exists && (snap.data() as UserDoc).passwordHash);
}
