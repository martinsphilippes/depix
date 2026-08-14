/**
 * Superfície do domínio que roda no dispositivo.
 *
 * Existe porque `index.ts` reexporta `idempotency.ts`, que importa
 * `node:crypto` — e um bundler de navegador não tem o que fazer com isso. O
 * erro seria de build, mas a separação vale por si: chave de idempotência é
 * assunto de servidor (é o que casa com a constraint UNIQUE do banco), e não
 * há razão para o navegador conhecê-la.
 *
 * Regra ao mexer aqui: só entra módulo que não importe API de Node. É por
 * isso que `@depix/wallet` — o pacote que roda no dispositivo — importa desta
 * entrada, e não da principal.
 */

export * from './errors.ts';
export * from './assets.ts';
export * from './money.ts';
export * from './fees.ts';
export * from './transaction-status.ts';
