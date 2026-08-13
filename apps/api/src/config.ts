/**
 * Configuração e gate de ambiente.
 *
 * O gate é a implementação técnica da regra dos requisitos §34 e do
 * REGULATORY_ARCHITECTURE.md §7: fundos reais exigem intenção explícita,
 * e a aplicação **não sobe** se a configuração for perigosa. Falhar no
 * boot é muito melhor do que descobrir na primeira transação.
 */

import { DomainError } from '@depix/core';
import type { Environment } from '@depix/providers';

export interface AppConfig {
  readonly environment: Environment;
  readonly databaseUrl: string;
  readonly port: number;
  readonly ipHashSalt: string;
  readonly depix: {
    readonly providerCode: 'sandbox' | 'depixapp' | 'eulen';
    readonly apiKey?: string;
    readonly webhookSecret?: string;
    readonly baseUrl?: string;
  };
  /** `true` só quando tudo está liberado para mover dinheiro de verdade. */
  readonly realFundsEnabled: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new DomainError('missing_config', `Variável de ambiente obrigatória: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = (env['APP_ENV'] ?? 'development') as Environment;
  if (!['development', 'testnet', 'staging', 'production'].includes(environment)) {
    throw new DomainError('invalid_config', `APP_ENV inválido: ${environment}`);
  }

  const providerCode = (env['DEPIX_PROVIDER'] ?? 'sandbox') as AppConfig['depix']['providerCode'];
  const apiKey = env['DEPIX_API_KEY'];
  const realFundsFlag = env['ENABLE_REAL_FUNDS'] === 'yes';

  // --- Gate de produção ----------------------------------------------------
  if (environment === 'production') {
    if (!realFundsFlag) {
      throw new DomainError(
        'production_not_released',
        'Ambiente de produção exige ENABLE_REAL_FUNDS=yes. Antes disso: validação jurídica ' +
          '(REGULATORY_ARCHITECTURE.md §5), aprovação do operador e revisão de segurança.',
      );
    }
    if (providerCode === 'sandbox') {
      throw new DomainError(
        'sandbox_in_production',
        'Provider de sandbox em produção: nada seria liquidado de verdade.',
      );
    }
    if (!apiKey?.startsWith('sk_live_')) {
      throw new DomainError('missing_live_key', 'Produção exige chave sk_live_ do operador.');
    }
  }

  // Chave de produção fora de produção nunca é aceitável, em nenhum caminho.
  if (apiKey?.startsWith('sk_live_') && environment !== 'production') {
    throw new DomainError(
      'live_key_outside_production',
      `Chave sk_live_ presente com APP_ENV=${environment}. Recusado.`,
    );
  }

  if (realFundsFlag && environment !== 'production') {
    throw new DomainError(
      'real_funds_outside_production',
      'ENABLE_REAL_FUNDS só é válido com APP_ENV=production.',
    );
  }

  return {
    environment,
    databaseUrl: required(env, 'DATABASE_URL'),
    port: Number(env['PORT'] ?? 3001),
    // Salt do hash de IP: sem ele, o hash é reversível por força bruta
    // (o espaço de endereços IPv4 inteiro cabe numa tabela).
    ipHashSalt: required(env, 'IP_HASH_SALT'),
    depix: {
      providerCode,
      apiKey,
      webhookSecret: env['DEPIX_WEBHOOK_SECRET'],
      baseUrl: env['DEPIX_BASE_URL'],
    },
    realFundsEnabled: environment === 'production' && realFundsFlag,
  };
}

/** Banner de inicialização — deixa óbvio, no log, se há dinheiro real em jogo. */
export function startupBanner(config: AppConfig): string {
  return config.realFundsEnabled
    ? `⚠️  PRODUÇÃO — FUNDOS REAIS · provider=${config.depix.providerCode}`
    : `ambiente=${config.environment} · provider=${config.depix.providerCode} · sem fundos reais`;
}
