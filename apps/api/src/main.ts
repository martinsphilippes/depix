import { start } from './server.ts';

start().catch((err: unknown) => {
  // Falha de configuração precisa ser legível: é o gate que impede a
  // aplicação subir apontada para dinheiro real sem liberação.
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
