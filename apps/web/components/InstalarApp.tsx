'use client';

/**
 * Convite para instalar o aplicativo.
 *
 * O navegador dispara `beforeinstallprompt` quando os critérios de
 * instalação são atendidos, e guardar esse evento é a única forma de abrir o
 * diálogo na hora que **nós** escolhemos. Sem isso, o Chrome mostra um ícone
 * discreto na barra que quase ninguém nota.
 *
 * Duas decisões de comportamento:
 *
 * **Não aparece se já estiver instalado.** `display-mode: standalone`
 * significa que o usuário já está dentro do aplicativo — oferecer instalação
 * ali é dizer a alguém sentado que ele pode se sentar.
 *
 * **Recusar é definitivo.** Quem dispensa não vê de novo neste navegador. Um
 * convite que reaparece é um anúncio, e um anúncio numa carteira gasta a
 * confiança que a gente precisa ter na hora de avisar algo sério.
 *
 * No iOS o evento não existe — a Apple não o implementa. Lá o caminho é
 * Compartilhar → "Adicionar à Tela de Início", e a instrução aparece em vez
 * do botão.
 */

import { useEffect, useState } from 'react';

interface PromptDeInstalacao extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISPENSADO = 'depix.instalacao.dispensada';

export function InstalarApp() {
  const [evento, setEvento] = useState<PromptDeInstalacao | null>(null);
  const [instalado, setInstalado] = useState(false);
  const [iOS, setIOS] = useState(false);

  useEffect(() => {
    const emApp =
      window.matchMedia('(display-mode: standalone)').matches ||
      // Como o Safari sinaliza o mesmo estado.
      (window.navigator as { standalone?: boolean }).standalone === true;
    setInstalado(emApp);

    setIOS(/iphone|ipad|ipod/i.test(navigator.userAgent) && !emApp);

    const capturar = (e: Event) => {
      // Impede o aviso automático do navegador para usarmos o nosso.
      e.preventDefault();
      if (localStorage.getItem(DISPENSADO) === 'sim') return;
      setEvento(e as PromptDeInstalacao);
    };

    window.addEventListener('beforeinstallprompt', capturar);
    window.addEventListener('appinstalled', () => setInstalado(true));
    return () => window.removeEventListener('beforeinstallprompt', capturar);
  }, []);

  if (instalado) return null;

  if (iOS) {
    return (
      <div className="notice notice-info">
        <strong>Instalar no iPhone.</strong>
        <br />
        Toque em Compartilhar e depois em <strong>Adicionar à Tela de Início</strong>. A carteira
        passa a abrir como aplicativo, sem barra de endereço.
      </div>
    );
  }

  if (!evento) return null;

  return (
    <div className="notice notice-info">
      <strong>Instale a carteira.</strong>
      <br />
      Ela passa a abrir como aplicativo, direto da tela de início.
      <br />
      <br />
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          style={{ display: 'inline-block', width: 'auto' }}
          onClick={() => {
            void evento.prompt();
            void evento.userChoice.finally(() => setEvento(null));
          }}
        >
          Instalar
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ display: 'inline-block', width: 'auto' }}
          onClick={() => {
            localStorage.setItem(DISPENSADO, 'sim');
            setEvento(null);
          }}
        >
          Agora não
        </button>
      </span>
    </div>
  );
}
