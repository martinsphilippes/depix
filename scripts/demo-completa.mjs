/**
 * Passeio completo, do zero ao painel — com conta de e-mail e senha.
 *
 * Percorre o caminho inteiro que um usuário percorre, num Chromium de
 * verdade, e salva uma imagem de cada passo. Não é maquete: cada tela sai da
 * aplicação rodando contra a API e o banco.
 *
 * O autenticador WebAuthn virtual do Chrome fica ligado para que a
 * reautenticação por passkey funcione — mas a conta é criada com **senha**,
 * que é o caminho principal desta demonstração.
 */

import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.WEB_URL ?? 'http://localhost:3996';
const OUT = process.env.SHOT_DIR ?? '/tmp/completa';
mkdirSync(OUT, { recursive: true });

// Único por execução: o identificador tem constraint de unicidade, e rodar o
// passeio duas vezes com o mesmo e-mail bate — corretamente — em
// "já existe uma conta".
const EMAIL = `maria+${Date.now().toString(36)}@exemplo.br`;
const SENHA = 'minha frase secreta 2026';
const PIN = '271828';
const DESTINO =
  'tlq1qq2xvpcvfup5j8zscjq05u2wxxjcyewk7979f3mmz5l7uw5pqmx6xf5xy50hsn6vhkm5euwt72x878eq6zxx2z58hd7zrsg9qn';
const DESTINO_2 =
  'tlq1qqfn5cmzz4pf2p6y5xn3s3vamsjc4c2r0zqzs9lvv2xtxr3cvxvhxsftjqnvxu5cjc4unhzp4vlxxtd4qkzz0zsy4rvw7c2r0';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

// Autenticador virtual: o Chrome implementa WebAuthn de verdade contra uma
// chave de software. A verificação no servidor é a mesma de produção.
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

let n = 0;
const shot = async (nome, espera = 800) => {
  await page.waitForTimeout(espera);
  n += 1;
  const arquivo = `${OUT}/${String(n).padStart(2, '0')}-${nome}.png`;
  await page.screenshot({ path: arquivo, fullPage: true });
  console.log(`  ${String(n).padStart(2, '0')} ${nome}`);
};
const passo = (t) => console.log(`\n== ${t}`);

// ---------------------------------------------------------------------------
passo('1. primeira abertura, sem conta');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await shot('primeira-abertura', 1500);

passo('2. tela de entrar — senha e passkey lado a lado');
await page.goto(`${BASE}/entrar`, { waitUntil: 'networkidle' });
await shot('entrar');

passo('3. criar conta com e-mail e senha');
await page.getByRole('button', { name: /^Criar conta$/ }).first().click();
await page.waitForTimeout(400);
await page.fill('#identifier', EMAIL);
await page.fill('#senha', SENHA);
await page.fill('#senha2', SENHA);
await shot('criar-conta-preenchida');

await page.getByRole('button', { name: /^Criar conta$/ }).last().click();
await page.waitForURL(/\/carteira/, { timeout: 30_000 }).catch(async () => {
  const erro = await page.textContent('.notice-danger').catch(() => null);
  throw new Error(`cadastro não avançou: ${erro ?? 'sem mensagem na tela'}`);
});
await shot('carteira-escolha', 1500);

// ---------------------------------------------------------------------------
passo('4. gerar a carteira — 12 palavras');
await page.getByRole('button', { name: /Criar carteira nova/ }).click();
await page.waitForSelector('ol li', { timeout: 60_000 });
const palavras = await page.$$eval('ol li', (els) => els.map((e) => e.textContent.trim()));
await shot('frase-de-recuperacao');

passo('5. conferência obrigatória do backup');
await page.getByRole('button', { name: /Anotei minha frase/ }).click();
await page.waitForSelector('input[id^="p"]', { timeout: 10_000 });
await shot('conferir-backup');

for (const campo of await page.$$('input[id^="p"]')) {
  const id = await campo.getAttribute('id');
  await campo.fill(palavras[Number(id.slice(1))]);
}
await page.getByRole('button', { name: /^Confirmar$/ }).click();
await page.waitForSelector('input#pin', { timeout: 10_000 });

passo('6. PIN do cofre — diferente da senha da conta');
await page.fill('#pin', PIN);
await page.fill('#pin2', PIN);
await shot('definir-pin');

await page.getByRole('button', { name: /Concluir/ }).click();
await page.waitForTimeout(5000);

// ---------------------------------------------------------------------------
passo('7. receber por Pix — cobrança com QR');
await page.goto(`${BASE}/receber`, { waitUntil: 'networkidle' });
await shot('receber-escolha');

await page.getByRole('button', { name: /Receber por Pix/ }).click();
await page.fill('#amount', '250,00');
await page.getByRole('button', { name: /Gerar cobrança/ }).click();
await page.waitForSelector('.copy-box', { timeout: 30_000 });
await shot('receber-pix-qr');

passo('8. receber de outra carteira — endereço derivado no aparelho');
await page.goto(`${BASE}/receber`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Receber de outra carteira/ }).click();
await page.waitForSelector('img[alt*="QR"]', { timeout: 30_000 });
await shot('receber-endereco-qr');

// ---------------------------------------------------------------------------
passo('9. creditando saldo (o que o worker faz num Pix confirmado)');
execFileSync('node', ['--experimental-strip-types', 'scripts/creditar-demo.ts'], {
  encoding: 'utf8',
  env: process.env,
});

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await shot('inicio-com-saldo', 1800);

// ---------------------------------------------------------------------------
passo('10. contatos');
await page.goto(`${BASE}/contatos`, { waitUntil: 'networkidle' });
await page.fill('#label', 'Maria');
await page.fill('#destino', DESTINO);
await page.getByRole('button', { name: /Adicionar contato/ }).click();
await shot('contatos', 2000);

passo('11. trocar endereço de contato pede passkey');
await page.getByRole('button', { name: /Alterar endereço/ }).first().click();
await shot('contato-troca-endereco');

// ---------------------------------------------------------------------------
passo('12. enviar — primeiro envio, revisão com taxa');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await shot('enviar-escolha');

await page.getByRole('button', { name: /Enviar para outra carteira/ }).click();
await page.fill('#dest', DESTINO);
await page.fill('#valor', '80,00');
await page.getByRole('button', { name: /Revisar envio/ }).click();
await shot('enviar-revisao', 3000);

passo('13. política de segurança — sessão antiga, valor alto');
execFileSync('node', ['--experimental-strip-types', 'scripts/envelhecer-sessao-demo.ts'], {
  encoding: 'utf8',
  env: process.env,
});
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Enviar para outra carteira/ }).click();
await page.fill('#dest', DESTINO_2);
await page.fill('#valor', '800,00');
await page.getByRole('button', { name: /Revisar envio/ }).click();
await shot('enviar-pede-passkey', 3000);

passo('14. enviar Pix — honesto sobre o que falta');
await page.goto(`${BASE}/enviar`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Enviar Pix/ }).click();
await page.fill('#pixKey', 'joao@email.com');
await page.getByRole('button', { name: /Continuar/ }).click();
await shot('enviar-pix-pendente', 2000);

// ---------------------------------------------------------------------------
passo('15. extrato e avisos');
await page.goto(`${BASE}/historico`, { waitUntil: 'networkidle' });
await shot('extrato', 1500);

await page.goto(`${BASE}/avisos`, { waitUntil: 'networkidle' });
await shot('avisos', 1200);

// ---------------------------------------------------------------------------
passo('16. segurança da conta — senha cadastrada, passkey opcional');
await page.goto(`${BASE}/seguranca`, { waitUntil: 'networkidle' });
await shot('seguranca', 1500);

passo('17. cadastrar passkey na conta que já tem senha');
await page.getByRole('button', { name: /Cadastrar passkey/ }).click();
await shot('seguranca-com-passkey', 3000);

passo('18. ajustes');
await page.goto(`${BASE}/ajustes`, { waitUntil: 'networkidle' });
await shot('ajustes', 1500);

// ---------------------------------------------------------------------------
passo('19. painel administrativo');
execFileSync('node', ['--experimental-strip-types', 'scripts/promover-demo.ts'], {
  encoding: 'utf8',
  env: process.env,
});
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await shot('painel', 1500);

await page.getByRole('button', { name: /Rodar conciliação agora/ }).click();
await shot('painel-conciliado', 7000);

// ---------------------------------------------------------------------------
passo('20. sair e entrar de novo — só com e-mail e senha');
await context.clearCookies();
await page.goto(`${BASE}/entrar`, { waitUntil: 'networkidle' });
await page.fill('#identifier', EMAIL);
await page.fill('#senha', SENHA);
await shot('login-preenchido');

await page.getByRole('button', { name: /^Entrar$/ }).last().click();
await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30_000 });
await shot('logado-de-novo', 2000);

passo('21. senha errada');
await context.clearCookies();
await page.goto(`${BASE}/entrar`, { waitUntil: 'networkidle' });
await page.fill('#identifier', EMAIL);
await page.fill('#senha', 'senha-errada-mesmo-viu');
await page.getByRole('button', { name: /^Entrar$/ }).last().click();
await shot('senha-errada', 3000);

// ---------------------------------------------------------------------------
passo('22. offline — o PWA não mostra saldo de memória');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => navigator.serviceWorker.ready);
await context.setOffline(true);
await page.goto(`${BASE}/historico`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await shot('offline', 1200);
await context.setOffline(false);

await browser.close();
console.log(`\npronto: ${n} telas em ${OUT}`);
