'use client';

/**
 * Tela de offline.
 *
 * É a contrapartida da decisão do service worker de não guardar resposta de
 * API. Sem cache, o aplicativo sem rede não tem o que mostrar — e esta tela
 * diz isso com todas as letras, em vez de exibir um saldo antigo que pareceria
 * atual.
 *
 * A frase sobre o dinheiro não é consolo: é fato. Os fundos vivem na Liquid e
 * a chave está neste aparelho. Nossa indisponibilidade não é a indisponibilidade
 * do dinheiro dele, e é útil que o usuário saiba disso justamente no momento em
 * que o aplicativo falhou.
 */

import { useEffect, useState } from 'react';

export default function Offline() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const atualizar = () => setOnline(navigator.onLine);
    atualizar();
    window.addEventListener('online', atualizar);
    window.addEventListener('offline', atualizar);
    return () => {
      window.removeEventListener('online', atualizar);
      window.removeEventListener('offline', atualizar);
    };
  }, []);

  return (
    <>
      <h1>Sem conexão</h1>

      <div className="notice notice-warning">
        <strong>Não conseguimos falar com o servidor.</strong>
        <br />
        Não mostramos seu saldo de memória porque um saldo antigo pareceria o
        atual — e decidir um envio por um número desatualizado é como se perde
        dinheiro.
      </div>

      <div className="notice notice-info">
        Seu dinheiro não depende de nós estarmos no ar. Ele está na rede Liquid, e a chave está
        neste aparelho. O que falta agora é a conexão para consultar e enviar.
      </div>

      {online && (
        <div className="notice notice-info">
          A conexão voltou. Pode tentar de novo.
        </div>
      )}

      <button type="button" className="btn" onClick={() => window.location.reload()}>
        Tentar de novo
      </button>
    </>
  );
}
