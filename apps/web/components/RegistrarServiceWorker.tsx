'use client';

/**
 * Registro do service worker.
 *
 * Componente sem interface: existe só pelo efeito. Fica no layout para rodar
 * uma vez por sessão, em qualquer tela.
 *
 * Duas escolhas:
 *
 * **Registra depois do carregamento**, não durante. Baixar e instalar o
 * service worker compete por banda com o que o usuário está esperando ver — e
 * o primeiro carregamento é justamente o que não se beneficia dele.
 *
 * **Falha em silêncio.** Sem service worker o aplicativo funciona igual: só
 * não abre offline nem é instalável. Um erro visível aqui assustaria o usuário
 * por uma degradação que não afeta o dinheiro dele.
 */

import { useEffect } from 'react';

export function RegistrarServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const registrar = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Ver acima: degradação silenciosa é a resposta certa aqui.
      });
    };

    if (document.readyState === 'complete') registrar();
    else window.addEventListener('load', registrar, { once: true });

    return () => window.removeEventListener('load', registrar);
  }, []);

  return null;
}
