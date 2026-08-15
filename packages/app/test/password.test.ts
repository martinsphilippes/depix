/**
 * Autenticação por senha.
 *
 * Dois testes aqui valem mais que os outros:
 *
 * **A senha não aparece no documento.** Óbvio de dizer, fácil de quebrar num
 * refactor, e catastrófico quando quebra.
 *
 * **Conta inexistente e senha errada são indistinguíveis** — mesma mensagem e
 * tempo comparável. Sem isso, o tempo de resposta vira um oráculo de "esta
 * conta existe", e uma lista de contas de uma carteira é exatamente o que um
 * atacante quer antes de tentar senhas.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { money } from '@depix/core';
import { COLLECTIONS, createTestDb, type TestDb, type UserDoc } from '@depix/firestore';
import { creditAvailable, walletBalance } from '@depix/ledger';

import {
  MIN_LOGIN_MS,
  MIN_PASSWORD_LENGTH,
  changePassword,
  hasPassword,
  normalizeIdentifier,
  registerWithPassword,
  setPassword,
  verifyPassword,
} from '../src/index.ts';

const SENHA = 'uma-frase-que-so-eu-sei';
let db: TestDb;

before(async () => {
  db = await createTestDb('password');
});

after(async () => {
  await db?.close();
});

describe('cadastro com senha', () => {
  it('cria a conta e permite entrar', async () => {
    const conta = await registerWithPassword(db, {
      identifier: 'maria@exemplo.br',
      password: SENHA,
    });

    const login = await verifyPassword(db, {
      identifier: 'maria@exemplo.br',
      password: SENHA,
    });
    assert.equal(login.userId, conta.userId);
  });

  it('a senha NÃO é gravada — só o hash Argon2id', async () => {
    const conta = await registerWithPassword(db, {
      identifier: 'joao@exemplo.br',
      password: 'senha-secreta-do-joao',
    });

    const doc = await db.doc(`${COLLECTIONS.users}/${conta.userId}`).get();
    const user = doc.data() as UserDoc;
    const serializado = JSON.stringify(user);

    assert.ok(!serializado.includes('senha-secreta-do-joao'), 'a senha vazou para o documento');
    assert.match(user.passwordHash!, /^\$argon2id\$/, 'não é Argon2id');
    // Parâmetros do OWASP: 19 MiB de memória, 2 iterações. Baixar isso
    // silenciosamente é o tipo de mudança que ninguém percebe até o vazamento.
    assert.match(user.passwordHash!, /m=19456,t=2/);
  });

  it('a conta nasce com as contas contábeis', async () => {
    // Mesmo buraco que existia no cadastro por passkey: sem isto, o primeiro
    // depósito falharia ao creditar.
    const conta = await registerWithPassword(db, {
      identifier: 'contabil@exemplo.br',
      password: SENHA,
    });

    await creditAvailable(
      db,
      { transactionId: `cred-${conta.userId}`, userId: conta.userId, actor: 'teste' },
      money('DEPIX', 50_000n),
    );

    const saldo = await walletBalance(db, conta.userId, 'DEPIX');
    assert.equal(saldo.available.amount, 50_000n);
  });

  it('recusa identificador já usado', async () => {
    await registerWithPassword(db, { identifier: 'repetido@exemplo.br', password: SENHA });
    await assert.rejects(
      () => registerWithPassword(db, { identifier: 'repetido@exemplo.br', password: SENHA }),
      /Já existe uma conta/,
    );
  });

  it('o identificador é normalizado — maiúscula e espaço não criam outra conta', async () => {
    // Ninguém deve ficar de fora da própria conta por ter digitado com
    // maiúscula. A normalização precisa ser a mesma no cadastro e no login.
    await registerWithPassword(db, { identifier: 'Ana@Exemplo.BR', password: SENHA });

    const login = await verifyPassword(db, { identifier: '  ana@exemplo.br  ', password: SENHA });
    assert.ok(login.userId);
    assert.equal(normalizeIdentifier('  ANA@exemplo.br '), 'ana@exemplo.br');
  });

  it('aceita nome de usuário além de e-mail', async () => {
    const conta = await registerWithPassword(db, { identifier: 'maria_silva', password: SENHA });
    const doc = await db.doc(`${COLLECTIONS.users}/${conta.userId}`).get();

    // Sem e-mail: a conta continua pseudônima, como o §18 pede.
    assert.equal((doc.data() as UserDoc).email, null);
    assert.equal((doc.data() as UserDoc).handle, 'maria_silva');
  });
});

describe('força da senha', () => {
  it(`recusa senha com menos de ${MIN_PASSWORD_LENGTH} caracteres`, async () => {
    await assert.rejects(
      () => registerWithPassword(db, { identifier: 'curta@exemplo.br', password: 'curta12' }),
      new RegExp(`pelo menos ${MIN_PASSWORD_LENGTH}`),
    );
  });

  it('recusa senha óbvia de lista de vazamento', async () => {
    await assert.rejects(
      () => registerWithPassword(db, { identifier: 'obvia@exemplo.br', password: '123456789012' }),
      /listas de senhas vazadas/,
    );
  });

  it('não exige maiúscula, número nem símbolo', async () => {
    // Regras de composição produzem `Senha@123`: previsível para a máquina e
    // difícil para a pessoa. O NIST as abandonou, e nós também.
    const conta = await registerWithPassword(db, {
      identifier: 'frase@exemplo.br',
      password: 'meu cachorro se chama bolinha',
    });
    assert.ok(conta.userId);
  });

  it('recusa identificador malformado', async () => {
    for (const ruim of ['ab', 'com espaço', 'maria@', '@exemplo.br']) {
      await assert.rejects(
        () => registerWithPassword(db, { identifier: ruim, password: SENHA }),
        /e-mail|usuário/i,
        `aceitou "${ruim}"`,
      );
    }
  });
});

describe('login — o que ele não pode revelar', () => {
  it('senha errada e conta inexistente dão a MESMA mensagem', async () => {
    await registerWithPassword(db, { identifier: 'existe@exemplo.br', password: SENHA });

    const mensagemDe = async (identifier: string, password: string): Promise<string> => {
      try {
        await verifyPassword(db, { identifier, password });
        return '(não falhou)';
      } catch (e) {
        return (e as Error).message;
      }
    };

    const comSenhaErrada = await mensagemDe('existe@exemplo.br', 'senha-errada-mesmo');
    const semConta = await mensagemDe('nao-existe@exemplo.br', SENHA);

    assert.equal(comSenhaErrada, semConta, 'a mensagem revela quais contas existem');
    assert.match(comSenhaErrada, /incorretos/);
  });

  it('o tempo de resposta não denuncia se a conta existe', async () => {
    // O teste que justifica o hash de mentira: sem ele, conta inexistente
    // responde na hora e conta existente paga o Argon2 — diferença de ordens
    // de grandeza, trivial de medir pela rede.
    await registerWithPassword(db, { identifier: 'tempo@exemplo.br', password: SENHA });

    const medir = async (identifier: string): Promise<number> => {
      const inicio = process.hrtime.bigint();
      await verifyPassword(db, { identifier, password: 'senha-errada-qualquer' }).catch(
        () => undefined,
      );
      return Number(process.hrtime.bigint() - inicio) / 1e6;
    };

    // Aquece: a primeira chamada paga a geração do hash de mentira.
    await medir('aquecimento@exemplo.br');

    const comConta = await medir('tempo@exemplo.br');
    const semConta = await medir('fantasma@exemplo.br');

    // Com o piso de tempo, os dois caminhos levam praticamente o mesmo. O
    // limiar é apertado de propósito: frouxo demais, o teste passaria mesmo
    // com o vazamento de volta.
    const razao = Math.max(comConta, semConta) / Math.min(comConta, semConta);
    assert.ok(
      razao < 1.3,
      `tempos diferentes demais: com conta ${comConta.toFixed(0)}ms, sem conta ` +
        `${semConta.toFixed(0)}ms (razão ${razao.toFixed(2)}×)`,
    );
    assert.ok(
      Math.min(comConta, semConta) >= MIN_LOGIN_MS * 0.9,
      `o piso de ${MIN_LOGIN_MS}ms não foi aplicado`,
    );
  });

  it('conta suspensa não entra', async () => {
    const conta = await registerWithPassword(db, { identifier: 'susp@exemplo.br', password: SENHA });
    await db.doc(`${COLLECTIONS.users}/${conta.userId}`).set({ status: 'suspended' }, { merge: true });

    await assert.rejects(
      () => verifyPassword(db, { identifier: 'susp@exemplo.br', password: SENHA }),
      /suspensa/,
    );
  });

  it('conta suspensa com senha ERRADA devolve credencial inválida, não "suspensa"', async () => {
    // Senão o status vira oráculo: quem não sabe a senha descobriria que a
    // conta existe e está suspensa.
    const conta = await registerWithPassword(db, { identifier: 'susp2@exemplo.br', password: SENHA });
    await db.doc(`${COLLECTIONS.users}/${conta.userId}`).set({ status: 'suspended' }, { merge: true });

    await assert.rejects(
      () => verifyPassword(db, { identifier: 'susp2@exemplo.br', password: 'errada-mesmo-viu' }),
      /incorretos/,
    );
  });
});

describe('troca de senha', () => {
  it('troca com a senha atual correta', async () => {
    const conta = await registerWithPassword(db, { identifier: 'troca@exemplo.br', password: SENHA });

    await changePassword(db, {
      userId: conta.userId,
      currentPassword: SENHA,
      newPassword: 'uma-senha-nova-bem-diferente',
    });

    await assert.rejects(
      () => verifyPassword(db, { identifier: 'troca@exemplo.br', password: SENHA }),
      /incorretos/,
    );
    const login = await verifyPassword(db, {
      identifier: 'troca@exemplo.br',
      password: 'uma-senha-nova-bem-diferente',
    });
    assert.equal(login.userId, conta.userId);
  });

  it('exige a senha atual — sessão roubada não expulsa o dono', async () => {
    const conta = await registerWithPassword(db, { identifier: 'troca2@exemplo.br', password: SENHA });

    await assert.rejects(
      () =>
        changePassword(db, {
          userId: conta.userId,
          currentPassword: 'chute-do-atacante',
          newPassword: 'senha-do-atacante-aqui',
        }),
      /incorretos/,
    );
  });

  it('recusa repetir a mesma senha', async () => {
    const conta = await registerWithPassword(db, { identifier: 'troca3@exemplo.br', password: SENHA });
    await assert.rejects(
      () =>
        changePassword(db, {
          userId: conta.userId,
          currentPassword: SENHA,
          newPassword: SENHA,
        }),
      /diferente da atual/,
    );
  });
});

describe('senha numa conta que só tinha passkey', () => {
  it('define e passa a permitir login por senha', async () => {
    // Conta sem senha, como as criadas por passkey.
    const ref = db.collection(COLLECTIONS.users).doc();
    await ref.create({
      handle: 'so-passkey',
      email: null,
      emailVerified: false,
      status: 'active',
      advancedMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    assert.equal(await hasPassword(db, ref.id), false);

    await setPassword(db, {
      userId: ref.id,
      identifier: 'so-passkey@exemplo.br',
      password: SENHA,
    });

    assert.equal(await hasPassword(db, ref.id), true);
    const login = await verifyPassword(db, {
      identifier: 'so-passkey@exemplo.br',
      password: SENHA,
    });
    assert.equal(login.userId, ref.id);
  });

  it('recusa identificador que já é de outra conta', async () => {
    await registerWithPassword(db, { identifier: 'ocupado@exemplo.br', password: SENHA });

    const ref = db.collection(COLLECTIONS.users).doc();
    await ref.create({
      handle: 'outro',
      email: null,
      emailVerified: false,
      status: 'active',
      advancedMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await assert.rejects(
      () => setPassword(db, { userId: ref.id, identifier: 'ocupado@exemplo.br', password: SENHA }),
      /Já existe uma conta/,
    );
  });
});
