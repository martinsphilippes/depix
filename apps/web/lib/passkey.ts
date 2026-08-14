/**
 * Cerimônia de passkey no navegador.
 *
 * O lado servidor (`packages/app/src/auth/webauthn.ts`) gera o desafio e
 * verifica a assinatura. Aqui só entregamos as opções ao navegador e
 * devolvemos o que ele assinou — nenhuma decisão de segurança acontece neste
 * arquivo, e é importante que continue assim: o cliente é a parte que o
 * atacante controla.
 *
 * Para a UI, o que importa é distinguir três desfechos, porque a resposta ao
 * usuário é diferente em cada um:
 *
 *   • o usuário cancelou ou deixou expirar → não é erro, não assuste;
 *   • o navegador não tem passkey para este site → oriente a cadastrar;
 *   • o servidor recusou → aí sim é falha de verdade.
 */

import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';

import { ApiRequestError } from './api';

export class PasskeyCancelled extends Error {
  constructor() {
    super('Confirmação cancelada.');
    this.name = 'PasskeyCancelled';
  }
}

export class PasskeyUnsupported extends Error {
  constructor() {
    super(
      'Este navegador não suporta passkey. Use um navegador atualizado — sem passkey não há ' +
        'como confirmar a operação com segurança.',
    );
    this.name = 'PasskeyUnsupported';
  }
}

export function supported(): boolean {
  return browserSupportsWebAuthn();
}

/**
 * O usuário cancelar o diálogo do sistema chega como `NotAllowedError`, o
 * mesmo nome que o navegador usa quando o tempo expira. Os dois casos são,
 * para nós, a mesma coisa: nada aconteceu.
 */
function translate(err: unknown): never {
  if (err instanceof ApiRequestError) throw err;
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') throw new PasskeyCancelled();
  if (name === 'InvalidStateError') {
    throw new Error('Este dispositivo já tem uma passkey cadastrada para esta conta.');
  }
  throw err instanceof Error ? err : new Error('Falha na confirmação por passkey.');
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiRequestError(response.status, parsed.error ?? {
      code: 'unknown',
      message: 'Erro inesperado',
    });
  }
  return parsed as T;
}

export interface RegisterResult {
  userId: string;
  backedUp: boolean;
  warning: string | null;
}

/** Cria conta e primeira passkey. Não há senha, nem e-mail, nem nome. */
export async function register(label?: string): Promise<RegisterResult> {
  if (!supported()) throw new PasskeyUnsupported();
  try {
    const { options } = await post<{ options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>(
      '/auth/register/start',
    );
    const response = await startRegistration({ optionsJSON: options });
    return await post<RegisterResult>('/auth/register/finish', {
      response,
      ...(label ? { label } : {}),
    });
  } catch (err) {
    translate(err);
  }
}

/** Login sem identificador: a passkey descobrível já diz quem é o usuário. */
export async function login(): Promise<{ userId: string }> {
  if (!supported()) throw new PasskeyUnsupported();
  try {
    const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
      '/auth/login/start',
    );
    const response = await startAuthentication({ optionsJSON: options });
    return await post<{ userId: string }>('/auth/login/finish', { response });
  } catch (err) {
    translate(err);
  }
}

/**
 * Confirma identidade numa sessão já aberta.
 *
 * É o que destrava um envio recusado com `reauth_required`. O servidor amarra
 * a confirmação à sessão que a pediu, então confirmar numa aba não libera
 * outra.
 */
export async function reauth(): Promise<void> {
  if (!supported()) throw new PasskeyUnsupported();
  try {
    const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
      '/auth/reauth/start',
    );
    const response = await startAuthentication({ optionsJSON: options });
    await post<{ confirmed: boolean }>('/auth/reauth/finish', { response });
  } catch (err) {
    translate(err);
  }
}
