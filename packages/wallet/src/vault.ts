/**
 * Cofre local — onde a frase de recuperação fica entre uma sessão e outra.
 *
 * Este é o módulo mais delicado do pacote, e a razão é simples: guardar a
 * frase é um requisito de usabilidade (ninguém digita 12 palavras a cada
 * envio) que colide de frente com o requisito §15, "nunca armazenar seed
 * phrase em texto puro". A conciliação é cifrar em repouso com uma chave que
 * **não está armazenada em lugar nenhum** — ela é derivada, a cada
 * destravamento, de algo que só o usuário sabe.
 *
 * ## Por que existe um PIN se a conta é passkey
 *
 * A conta autentica com passkey e não tem senha. O cofre, porém, não é a
 * conta: ele protege o dinheiro contra quem já tem o dispositivo destravado
 * — um navegador aberto, uma extensão maliciosa, um XSS. Uma passkey
 * autentica *para o servidor*; ela não produz, por si só, um segredo local
 * do qual derivar uma chave de cifra.
 *
 * (A extensão PRF do WebAuthn produziria exatamente isso, e seria a evolução
 * natural deste módulo. Não é usada aqui porque o suporte ainda é desigual
 * entre navegadores e autenticadores, e um cofre que só destrava em metade
 * dos dispositivos tranca o usuário do lado de fora do próprio dinheiro. O
 * formato guarda `kdf` para permitir a migração sem quebrar cofres antigos.)
 *
 * ## O que este módulo garante — e o que não garante
 *
 * Garante: quem copiar o conteúdo do armazenamento local não obtém a frase.
 * Precisa do PIN, e cada tentativa custa 600 mil iterações de PBKDF2.
 *
 * **Não garante** proteção contra código malicioso rodando na página
 * *enquanto o cofre está destravado*. Nesse instante a frase está em memória,
 * porque assinar exige a chave. Daí a CSP restritiva do `apps/web` e a regra
 * de descartar o signer logo após assinar: reduzir a janela é o que dá para
 * fazer, e é honesto dizer que é uma redução, não uma eliminação.
 */

import { DomainError } from '@depix/core/browser';

/**
 * Iterações do PBKDF2.
 *
 * 600.000 é a recomendação do OWASP para PBKDF2-HMAC-SHA256 (Password
 * Storage Cheat Sheet). Custa ~0,3 s num celular modesto — aceitável uma vez
 * por destravamento, e caro o bastante para tornar força bruta sobre um PIN
 * de 6 dígitos algo que se mede em dias, não em segundos.
 */
const PBKDF2_ITERATIONS = 600_000;

/** Mínimo do PIN. Abaixo disso o KDF não compensa o espaço de busca. */
export const MIN_PIN_LENGTH = 6;

export interface VaultBlob {
  /** Versão do formato — permite migrar sem perder cofres existentes. */
  readonly v: 1;
  readonly kdf: 'pbkdf2-sha256';
  readonly iterations: number;
  /** base64 */
  readonly salt: string;
  /** base64 */
  readonly iv: string;
  /** base64 — ciphertext + tag GCM */
  readonly data: string;
  /** Público e não secreto: identifica a carteira sem revelá-la. */
  readonly fingerprint: string;
  readonly network: 'mainnet' | 'testnet';
  readonly createdAt: string;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new DomainError(
      'no_webcrypto',
      'Este navegador não expõe WebCrypto. Sem ele não há como cifrar a frase de ' +
        'recuperação, e guardá-la em claro não é opção.',
    );
  }
  return c.subtle;
}

const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};

const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    // `extractable: false`: a chave derivada nunca vira bytes em JavaScript.
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface SealParams {
  readonly mnemonic: string;
  readonly pin: string;
  readonly fingerprint: string;
  readonly network: 'mainnet' | 'testnet';
  readonly now?: Date;
}

/** Cifra a frase. O resultado pode ser persistido; o PIN, não. */
export async function sealVault(params: SealParams): Promise<VaultBlob> {
  assertPin(params.pin);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(params.pin, salt, PBKDF2_ITERATIONS);

  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    new TextEncoder().encode(params.mnemonic.trim()),
  );

  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(data),
    fingerprint: params.fingerprint,
    network: params.network,
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

/**
 * Decifra a frase.
 *
 * PIN errado cai no `catch`: o AES-GCM falha na verificação da tag, que é o
 * que torna o formato autenticado — ninguém consegue adulterar o cofre para
 * que ele devolva outra frase.
 */
export async function openVault(blob: VaultBlob, pin: string): Promise<string> {
  if (blob.v !== 1 || blob.kdf !== 'pbkdf2-sha256') {
    throw new DomainError(
      'unsupported_vault',
      'O cofre local está num formato que esta versão não reconhece. ' +
        'Restaure a carteira com sua frase de recuperação.',
    );
  }

  const key = await deriveKey(pin, unb64(blob.salt), blob.iterations);

  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) },
      key,
      unb64(blob.data),
    );
  } catch {
    // Mensagem deliberadamente sem detalhe: não dizemos se o cofre está
    // corrompido ou se o PIN está errado, porque a diferença só interessa a
    // quem está tentando adivinhar.
    throw new DomainError('wrong_pin', 'PIN incorreto.');
  }

  return new TextDecoder().decode(plain);
}

/** Troca o PIN sem alterar a carteira. Exige o PIN atual. */
export async function changePin(
  blob: VaultBlob,
  currentPin: string,
  newPin: string,
): Promise<VaultBlob> {
  const mnemonic = await openVault(blob, currentPin);
  return sealVault({
    mnemonic,
    pin: newPin,
    fingerprint: blob.fingerprint,
    network: blob.network,
  });
}

function assertPin(pin: string): void {
  if (pin.length < MIN_PIN_LENGTH) {
    throw new DomainError(
      'weak_pin',
      `O PIN precisa ter pelo menos ${MIN_PIN_LENGTH} caracteres.`,
    );
  }
}

/**
 * Verifica se o texto tem cara de cofre válido.
 *
 * Usado ao ler do armazenamento local, que é escrevível por qualquer código
 * da mesma origem e portanto não é fonte confiável de estrutura.
 */
export function isVaultBlob(value: unknown): value is VaultBlob {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === 1 &&
    typeof v['kdf'] === 'string' &&
    typeof v['iterations'] === 'number' &&
    typeof v['salt'] === 'string' &&
    typeof v['iv'] === 'string' &&
    typeof v['data'] === 'string' &&
    typeof v['fingerprint'] === 'string' &&
    (v['network'] === 'mainnet' || v['network'] === 'testnet')
  );
}
