/**
 * Autenticador WebAuthn de software, para teste.
 *
 * Existe porque testar passkey de outra forma seria testar mocks. Aqui a
 * assinatura é ECDSA P-256 de verdade, verificada pela mesma biblioteca que
 * roda em produção — o que significa que o teste falha se a origem, o RP ID,
 * o challenge ou o contador estiverem errados.
 *
 * Implementa o mínimo da especificação necessário para os fluxos que usamos:
 * atestado `none` (não revelamos modelo de autenticador) e asserção ES256.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { encode as cborEncode } from 'cbor2';

const b64url = (buf: Buffer | Uint8Array): string =>
  Buffer.from(buf).toString('base64url');

/** Flags do authenticatorData (WebAuthn §6.1). */
const FLAG_UP = 0x01; // usuário presente
const FLAG_UV = 0x04; // usuário verificado (biometria/PIN)
const FLAG_BE = 0x08; // elegível a backup
const FLAG_BS = 0x10; // com backup feito
const FLAG_AT = 0x40; // dados de credencial atestada presentes

export interface AuthenticatorOptions {
  readonly rpID: string;
  readonly origin: string;
  /** Simula autenticador que não implementa contador (mantém em zero). */
  readonly staticCounter?: boolean;
}

export class SoftwareAuthenticator {
  readonly credentialId: Buffer;
  #privateKey: KeyObject;
  #publicKey: KeyObject;
  #counter = 0;
  readonly #opts: AuthenticatorOptions;

  constructor(opts: AuthenticatorOptions) {
    this.#opts = opts;
    this.credentialId = randomBytes(32);

    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  get counter(): number {
    return this.#counter;
  }

  /** Força o contador — usado para simular credencial clonada. */
  setCounter(value: number): void {
    this.#counter = value;
  }

  /** Chave pública em COSE_Key (RFC 8152), como o autenticador entrega. */
  #cosePublicKey(): Buffer {
    const jwk = this.#publicKey.export({ format: 'jwk' }) as { x: string; y: string };

    // Chaves inteiras exigem Map: objeto viraria chave string no CBOR.
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]);
    return Buffer.from(cborEncode(cose));
  }

  #authenticatorData(opts: { includeAttestedCredential: boolean; userVerified: boolean }): Buffer {
    const rpIdHash = createHash('sha256').update(this.#opts.rpID).digest();

    let flags = FLAG_UP | FLAG_BE | FLAG_BS;
    if (opts.userVerified) flags |= FLAG_UV;
    if (opts.includeAttestedCredential) flags |= FLAG_AT;

    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(this.#counter, 0);

    const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), counterBytes];

    if (opts.includeAttestedCredential) {
      const aaguid = Buffer.alloc(16); // zeros: autenticador não identificado
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(this.credentialId.length, 0);
      parts.push(aaguid, credIdLen, this.credentialId, this.#cosePublicKey());
    }

    return Buffer.concat(parts);
  }

  #clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.#opts.origin,
        crossOrigin: false,
      }),
    );
  }

  /** Resposta de registro (`navigator.credentials.create`). */
  register(challenge: string): Record<string, unknown> {
    const clientDataJSON = this.#clientDataJSON('webauthn.create', challenge);
    const authData = this.#authenticatorData({
      includeAttestedCredential: true,
      userVerified: true,
    });

    const attestationObject = Buffer.from(
      cborEncode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]),
      ),
    );

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /**
   * Resposta de autenticação (`navigator.credentials.get`).
   *
   * Incrementa o contador, como um autenticador real faz — é o que permite
   * detectar clonagem quando ele deixa de avançar.
   */
  authenticate(challenge: string, opts: { userVerified?: boolean } = {}): Record<string, unknown> {
    if (!this.#opts.staticCounter) this.#counter++;

    const clientDataJSON = this.#clientDataJSON('webauthn.get', challenge);
    const authData = this.#authenticatorData({
      includeAttestedCredential: false,
      userVerified: opts.userVerified ?? true,
    });

    const signatureBase = Buffer.concat([
      authData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const signature = createSign('sha256').update(signatureBase).sign(this.#privateKey);

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /**
   * Assina com origem diferente — simula phishing.
   *
   * O site clonado consegue pedir a assinatura, mas o `origin` dentro do
   * clientData é do domínio real do autenticador, não do falso. É por isso
   * que passkey resiste a phishing, e o teste verifica que a verificação
   * recusa.
   */
  authenticateFromOrigin(challenge: string, origin: string): Record<string, unknown> {
    const original = this.#opts.origin;
    (this.#opts as { origin: string }).origin = origin;
    try {
      return this.authenticate(challenge);
    } finally {
      (this.#opts as { origin: string }).origin = original;
    }
  }
}
