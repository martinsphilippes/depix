'use client';

/**
 * Leitor de QR.
 *
 * Duas decisões de comportamento que valem mais do que o visual:
 *
 * **A câmera desliga sozinha.** No desmonte do componente, na primeira
 * leitura e quando o usuário cancela. Uma luz de câmera acesa numa carteira,
 * depois de o trabalho estar feito, é o tipo de coisa que faz o usuário
 * desconfiar do aplicativo — com razão.
 *
 * **Não existe caminho sem alternativa.** Se o navegador não tem
 * `BarcodeDetector`, ou se a permissão é negada, o componente diz isso e
 * some — quem o usa continua tendo o campo de colar. Uma câmera que não abre
 * não pode virar um beco.
 */

import { useEffect, useRef, useState } from 'react';

import { type ScanHandle, classifyScan, scanQr, scannerSupported } from '../lib/qr-scan';

export interface QrScannerProps {
  /** Recebe o texto lido, já classificado. */
  readonly onScan: (value: ReturnType<typeof classifyScan>) => void;
  readonly onClose: () => void;
}

export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ScanHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    void (async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        const handle = await scanQr(video, (texto) => {
          if (cancelado) return;
          onScan(classifyScan(texto));
        });
        if (cancelado) {
          // O componente desmontou enquanto a permissão era pedida: desliga
          // a câmera que acabou de abrir.
          handle.stop();
          return;
        }
        handleRef.current = handle;
      } catch (err) {
        if (!cancelado) setError((err as Error).message);
      }
    })();

    return () => {
      cancelado = true;
      handleRef.current?.stop();
    };
  }, [onScan]);

  if (error) {
    return (
      <div className="notice notice-warning">
        {error}
        <br />
        <br />
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <video
        ref={videoRef}
        muted
        playsInline
        style={{
          width: '100%',
          borderRadius: 10,
          background: '#000',
          aspectRatio: '1 / 1',
          objectFit: 'cover',
        }}
      />
      <div className="tx-meta" style={{ marginTop: 10, textAlign: 'center' }}>
        Aponte para o QR Code
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: 10 }}
        onClick={() => {
          handleRef.current?.stop();
          onClose();
        }}
      >
        Cancelar
      </button>
    </div>
  );
}

/** Botão que só aparece onde a câmera funciona. */
export function QrScanButton({ onClick }: { onClick: () => void }) {
  const [suportado, setSuportado] = useState(false);
  useEffect(() => setSuportado(scannerSupported()), []);

  if (!suportado) return null;

  return (
    <button type="button" className="btn btn-secondary" onClick={onClick}>
      Ler QR Code
    </button>
  );
}
