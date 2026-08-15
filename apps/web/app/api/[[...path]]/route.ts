/**
 * A API inteira, servida pelo Next — mesma origem que a interface.
 *
 * Em desenvolvimento a API roda como processo Fastify separado, em outra
 * porta. Publicada na Vercel, ela vira função serverless montada aqui. O
 * mesmo `buildServer` atende os dois casos: não há uma segunda implementação
 * das rotas, e nada pode divergir entre o que se testa e o que se publica.
 *
 * ## Por que mesma origem
 *
 * Não é economia de infraestrutura. Servir a API em `/api/*` no mesmo domínio
 * resolve três coisas de uma vez:
 *
 *   • **CORS deixa de existir.** Sem lista de origens para manter em dois
 *     lugares e divergir em produção.
 *   • **O cookie de sessão fica same-site de verdade**, e `SameSite=Strict`
 *     passa a valer sem exceção.
 *   • **O RP ID do WebAuthn é o próprio domínio.** Interface e API na mesma
 *     origem eliminam a classe inteira de erro em que a passkey é registrada
 *     num domínio e verificada contra outro.
 *
 * ## Como o Fastify roda aqui
 *
 * Por `app.inject()`, que despacha pelo pipeline completo — hooks, plugins,
 * parser de corpo bruto, tratador de erro. Não é atalho de teste: é a forma
 * de entregar uma requisição ao Fastify sem um socket, que é exatamente a
 * situação de uma função serverless.
 *
 * O corpo chega como `Buffer` e é repassado como `Buffer`. Isso importa mais
 * do que parece: o webhook verifica assinatura HMAC sobre os **bytes
 * originais**, e reserializar o JSON no caminho quebraria a verificação.
 */

import type { FastifyInstance } from 'fastify';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
// Toda rota financeira lê e escreve: nada aqui pode ser cacheado ou
// pré-renderizado.
export const dynamic = 'force-dynamic';

/**
 * Instância reaproveitada entre invocações.
 *
 * A Vercel reusa o processo entre requisições próximas. Reconstruir o servidor
 * — e reabrir a conexão com o Firestore — a cada chamada custaria mais que a
 * própria operação.
 */
let servidor: Promise<FastifyInstance> | null = null;

async function obterServidor(): Promise<FastifyInstance> {
  servidor ??= (async () => {
    const { buildServer, buildDepixProvider } = await import('@depix/api/server');
    const { loadConfig } = await import('@depix/api/config');
    const { createDb, createFirestore } = await import('@depix/firestore');
    const { loadEncryptionKey } = await import('@depix/app');

    const config = loadConfig();
    const fs = createFirestore({
      projectId: config.firebase.projectId,
      ...(config.firebase.emulatorHost ? { emulatorHost: config.firebase.emulatorHost } : {}),
      ...(config.firebase.databaseId ? { databaseId: config.firebase.databaseId } : {}),
      ...(config.firebase.credentials ? { credentials: config.firebase.credentials } : {}),
    });

    return buildServer({
      config,
      db: createDb(fs),
      depixProvider: buildDepixProvider(config),
      encryptionKey: loadEncryptionKey(),
    });
  })();

  return servidor;
}

async function despachar(request: NextRequest): Promise<Response> {
  let app: FastifyInstance;
  try {
    app = await obterServidor();
  } catch (err) {
    // Configuração faltando derruba o boot de propósito (o gate do §34). Numa
    // função serverless isso vira 500 sem explicação, então a mensagem é
    // devolvida: quem está publicando precisa saber qual variável falta.
    return Response.json(
      {
        error: {
          code: 'server_misconfigured',
          message: String(err instanceof Error ? err.message : err),
        },
      },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const corpo =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer());

  const resposta = await app.inject({
    method: request.method as 'GET',
    // `/api` é o prefixo do Next; as rotas do Fastify não o conhecem.
    url: url.pathname.replace(/^\/api/, '') + url.search || '/',
    headers: Object.fromEntries(request.headers.entries()),
    ...(corpo && corpo.length > 0 ? { payload: corpo } : {}),
  });

  const cabecalhos = new Headers();
  for (const [chave, valor] of Object.entries(resposta.headers)) {
    if (valor === undefined) continue;
    // `set-cookie` pode vir como lista, e concatenar quebraria o cookie.
    if (Array.isArray(valor)) for (const v of valor) cabecalhos.append(chave, String(v));
    else cabecalhos.set(chave, String(valor));
  }

  // Copia para um `ArrayBuffer` próprio.
  //
  // O corpo de `Response` não aceita `Buffer` nem uma view sobre
  // `ArrayBufferLike` — e a view do `Buffer` do Node aponta para um pool
  // compartilhado, então entregá-la crua arriscaria devolver bytes de outra
  // requisição. A cópia é barata e remove a dúvida.
  const bytes = resposta.rawPayload.buffer.slice(
    resposta.rawPayload.byteOffset,
    resposta.rawPayload.byteOffset + resposta.rawPayload.byteLength,
  ) as ArrayBuffer;

  return new Response(bytes, {
    status: resposta.statusCode,
    headers: cabecalhos,
  });
}

export const GET = despachar;
export const POST = despachar;
export const PUT = despachar;
export const PATCH = despachar;
export const DELETE = despachar;
export const OPTIONS = despachar;
