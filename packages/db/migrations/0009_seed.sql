-- 0009 — Dados de referência
--
-- Idempotente: pode rodar novamente sem duplicar.

-- Ativos. O asset ID do DePix foi confirmado no registro on-chain durante o
-- discovery (ARCHITECTURE.md §1.1). É o único valor que distingue o ativo
-- real de uma falsificação com o mesmo ticker.
INSERT INTO assets (code, network, liquid_asset_id, decimals, display_name) VALUES
  ('BRL',   'fiat',   NULL, 2, 'Real'),
  ('DEPIX', 'liquid', '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189', 8, 'DePix'),
  ('LBTC',  'liquid', '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d', 8, 'Liquid Bitcoin')
ON CONFLICT (code) DO NOTHING;

-- Contas de sistema, uma por ativo movimentável.
INSERT INTO ledger_accounts (code, owner_user_id, asset_id, kind)
SELECT 'system:' || k.kind_name || ':' || a.code, NULL, a.id, k.kind_value
FROM assets a
CROSS JOIN (VALUES
  ('fees',       'system_fees'::account_kind),
  ('settlement', 'system_settlement'::account_kind),
  ('reserve',    'system_reserve'::account_kind),
  ('adjustment', 'system_adjustment'::account_kind),
  ('refunds',    'system_refunds'::account_kind),
  ('external',   'external_world'::account_kind)
) AS k(kind_name, kind_value)
WHERE a.code IN ('DEPIX', 'LBTC', 'BRL')
ON CONFLICT (code) DO NOTHING;

-- Taxas iniciais da plataforma: zero.
--
-- Decisão deliberada. A taxa do operador (2% + R$ 0,99 no depósito) já é
-- cobrada por ele e vem da cotação real. Definir a nossa em zero até que
-- exista decisão de negócio evita que um número inventado em migração vire
-- cobrança real por descuido. Alterar exige nova vigência, nunca UPDATE.
INSERT INTO fee_rules (operation, percent_ppm, fixed_amount, active_from)
SELECT op, 0, 0, now()
FROM (VALUES
  ('pix_in_to_depix'::tx_kind),
  ('depix_out_to_pix'::tx_kind),
  ('depix_send'::tx_kind)
) AS t(op)
WHERE NOT EXISTS (SELECT 1 FROM fee_rules WHERE fee_rules.operation = t.op);

-- Providers em ambiente de sandbox. `enabled = FALSE` para produção é o
-- padrão: habilitar exige ação explícita (requisitos §34).
INSERT INTO providers (code, kind, environment, enabled, config) VALUES
  ('sandbox',  'depix',     'development', TRUE,  '{"note":"adapter em memória, sem dinheiro real"}'),
  ('depixapp', 'depix',     'testnet',     FALSE, '{"baseUrl":"https://api.depixapp.com","docs":"https://depixapp.com/docs/en/"}'),
  ('depixapp', 'depix',     'production',  FALSE, '{"baseUrl":"https://api.depixapp.com","requires":"sk_live_ aprovado + validação jurídica"}'),
  ('eulen',    'depix',     'production',  FALSE, '{"baseUrl":"https://depix.eulen.app/api/","docs":"https://docs.eulen.app/"}'),
  ('esplora',  'liquid',    'production',  TRUE,  '{"baseUrl":"https://blockstream.info/liquid/api"}'),
  ('sideswap', 'swap',      'production',  FALSE, '{"docs":"https://sideswap.io/docs/"}')
ON CONFLICT (code, environment) DO NOTHING;
