/**
 * Configuração e gate de ambiente.
 *
 * O gate é a implementação técnica da regra dos requisitos §34 e do
 * REGULATORY_ARCHITECTURE.md §7: fundos reais exigem intenção explícita, e a
 * aplicação **não sobe** se a configuração for perigosa.
 *
 * A migração para o Firebase acrescentou um risco que não existia com o
 * PostgreSQL e que motiva duas checagens novas: com Firestore, a diferença
 * entre "banco de brincadeira" e "banco de produção" é uma variável de
 * ambiente. Apontar o desenvolvimento para o projeto real é fácil de fazer
 * por acidente e destrutivo — a suíte de testes, por exemplo, apaga todos os
 * documentos. Por isso:
 *
 *   • fora de produção, exigimos emulador **ou** confirmação explícita;
 *   • em produção, o emulador é recusado.
 */

import { DomainError } from '@depix/core';
import type { Environment } from '@depix/providers';

export interface AppConfig {
  readonly environment: Environment;
  readonly firebase: {
    readonly projectId: string;
    /** Host do emulador. Ausente = projeto real. */
    readonly emulatorHost?: string;
    readonly databaseId?: string;
  };
  readonly port: number;
  readonly ipHashSalt: string;
  readonly webauthn: {
    readonly rpName: string;
    /** Domínio, sem esquema nem porta. Errar aqui é abrir a porta a phishing. */
    readonly rpID: string;
    readonly origin: string[];
  };
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

  const projectId = required(env, 'FIREBASE_PROJECT_ID');
  const emulatorHost = env['FIRESTORE_EMULATOR_HOST'];
  const providerCode = (env['DEPIX_PROVIDER'] ?? 'sandbox') as AppConfig['depix']['providerCode'];
  const apiKey = env['DEPIX_API_KEY'];
  const realFundsFlag = env['ENABLE_REAL_FUNDS'] === 'yes';

  // --- Gate do Firestore ---------------------------------------------------
  if (environment === 'production' && emulatorHost) {
    throw new DomainError(
      'emulator_in_production',
      `FIRESTORE_EMULATOR_HOST definida (${emulatorHost}) com APP_ENV=production. ` +
        'Nada seria persistido de verdade.',
    );
  }

  if (environment !== 'production' && !emulatorHost && env['ALLOW_REAL_FIRESTORE'] !== 'yes') {
    throw new DomainError(
      'real_firestore_outside_production',
      `APP_ENV=${environment} apontado para o projeto Firestore real "${projectId}" sem emulador. ` +
        'Isso é quase sempre acidente e pode apagar ou corromper dados reais. ' +
        'Use FIRESTORE_EMULATOR_HOST=127.0.0.1:8080, ou defina ALLOW_REAL_FIRESTORE=yes se for intencional.',
    );
  }

  // Nome de projeto do emulador começa com "demo-" e não fala com o Google.
  // Um projeto assim em produção significa que nada seria gravado.
  if (environment === 'production' && projectId.startsWith('demo-')) {
    throw new DomainError(
      'demo_project_in_production',
      `Projeto "${projectId}" é um projeto de demonstração e não persiste dados reais.`,
    );
  }

  // WebAuthn sobre HTTP só faz sentido em localhost, e em produção seria
  // entregar a assinatura em claro. A origem é o que amarra a passkey ao
  // nosso domínio; aceitar http:// em produção anula a proteção antiphishing.
  const origins = (env['WEBAUTHN_ORIGIN'] ?? '').split(',').map((o) => o.trim());
  if (environment === 'production' && origins.some((o) => o.startsWith('http://'))) {
    throw new DomainError(
      'insecure_webauthn_origin',
      `WEBAUTHN_ORIGIN com http:// em produção (${origins.join(', ')}). ` +
        'Passkey exige HTTPS — sem isso a proteção contra phishing não vale.',
    );
  }

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
    firebase: {
      projectId,
      ...(emulatorHost ? { emulatorHost } : {}),
      ...(env['FIRESTORE_DATABASE_ID'] ? { databaseId: env['FIRESTORE_DATABASE_ID'] } : {}),
    },
    port: Number(env['PORT'] ?? 3001),
    // Salt do hash de IP: sem ele, o hash é reversível por força bruta (o
    // espaço de endereços IPv4 inteiro cabe numa tabela).
    ipHashSalt: required(env, 'IP_HASH_SALT'),
    webauthn: {
      rpName: env['WEBAUTHN_RP_NAME'] ?? 'Carteira',
      rpID: required(env, 'WEBAUTHN_RP_ID'),
      origin: required(env, 'WEBAUTHN_ORIGIN')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    },
    depix: {
      providerCode,
      ...(apiKey ? { apiKey } : {}),
      ...(env['DEPIX_WEBHOOK_SECRET'] ? { webhookSecret: env['DEPIX_WEBHOOK_SECRET'] } : {}),
      ...(env['DEPIX_BASE_URL'] ? { baseUrl: env['DEPIX_BASE_URL'] } : {}),
    },
    realFundsEnabled: environment === 'production' && realFundsFlag,
  };
}

/** Banner de inicialização — deixa óbvio, no log, se há dinheiro real em jogo. */
export function startupBanner(config: AppConfig): string {
  const store = config.firebase.emulatorHost
    ? `emulador(${config.firebase.emulatorHost})`
    : `firestore(${config.firebase.projectId})`;

  return config.realFundsEnabled
    ? `⚠️  PRODUÇÃO — FUNDOS REAIS · ${store} · provider=${config.depix.providerCode}`
    : `ambiente=${config.environment} · ${store} · provider=${config.depix.providerCode} · sem fundos reais`;
}
