/**
 * Cifragem em repouso.
 *
 * Usado para o descriptor CT watch-only. Ele não permite gastar, mas contém
 * a master blinding key: quem o tiver consegue **ver** os saldos e as
 * transações daquele usuário. É o trade-off já declarado em SECURITY.md §2 —
 * ver-sem-poder-gastar é o preço de detectar depósitos e conciliar no
 * servidor — e cifrar em repouso é o que limita o estrago de um vazamento de
 * banco.
 *
 * AES-256-GCM: cifra e autentica. Sem autenticação, um atacante com escrita
 * no banco poderia trocar o descriptor de um usuário pelo dele e passar a
 * observar depósitos alheios.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { DomainError } from '@depix/core';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Deriva a chave a partir da variável de ambiente.
 *
 * Em produção isto deve vir de um KMS/vault, não de `.env`. A checagem de
 * tamanho existe para que uma chave fraca não passe despercebida.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  // O trim tem história: variável colada em painel vem com quebra de linha
  // no final. O decodificador de base64 do Node a ignoraria por acaso —
  // melhor limpar de propósito do que depender disso.
  const raw = env['ENCRYPTION_KEY']?.trim();
  if (!raw) {
    throw new DomainError(
      'missing_encryption_key',
      'ENCRYPTION_KEY não definida. Gere 32 bytes aleatórios em base64 e guarde em KMS/vault.',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new DomainError(
      'invalid_encryption_key',
      `ENCRYPTION_KEY precisa ter exatamente ${KEY_BYTES} bytes em base64 (veio com ${key.length})`,
    );
  }
  return key;
}

/**
 * Cifra e devolve `iv || tag || ciphertext`.
 *
 * O IV é aleatório por operação: reusar IV em GCM quebra a cifra por
 * completo, não só enfraquece.
 */
export function encryptAtRest(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptAtRest(payload: Buffer, key: Buffer): string {
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new DomainError('invalid_ciphertext', 'Dado cifrado truncado ou corrompido');
  }

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Falha de autenticação: o dado foi adulterado ou a chave está errada.
    // Não distinguimos os dois casos na mensagem — isso é oráculo para
    // atacante.
    throw new DomainError('decryption_failed', 'Não foi possível decifrar o dado armazenado');
  }
}

/** Gera uma chave nova. Utilitário de operação, não usado em runtime. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
