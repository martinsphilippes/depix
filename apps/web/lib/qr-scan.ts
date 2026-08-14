'use client';

/**
 * Leitura de QR pela câmera (§28).
 *
 * Usa a `BarcodeDetector` do navegador, sem biblioteca de terceiros. A
 * escolha não é economia de bytes: uma dependência de decodificação de QR
 * roda sobre os quadros da câmera de uma carteira, e cada dependência nova
 * nesse caminho é código de terceiro com acesso à imagem e à mesma origem que
 * segura a seed. A CSP proíbe script externo justamente por isso.
 *
 * O preço é honesto: a `BarcodeDetector` não existe em todos os navegadores
 * — notadamente no Safari e no Firefox de desktop. Quando falta, o chamador
 * recebe `false` de `scannerSupported()` e a tela oferece o campo de colar,
 * que sempre funcionou. Uma câmera que não abre é bem menos grave do que um
 * endereço lido errado.
 *
 * ⚠️ O que sai daqui é texto que o usuário **não digitou**, vindo de uma
 * imagem que qualquer um pode ter impresso. Nunca é usado direto: quem chama
 * mostra o resultado na tela para conferência, e o endereço ainda passa pela
 * validação de rede em `parseAddress` antes de virar transação.
 */

interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function ctor(): BarcodeDetectorCtor | null {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

export function scannerSupported(): boolean {
  return ctor() !== null && typeof navigator !== 'undefined' && !!navigator.mediaDevices;
}

export class ScannerUnsupported extends Error {
  constructor() {
    super(
      'Este navegador não consegue ler QR pela câmera. Cole o código ou o endereço no campo ' +
        'abaixo — funciona igual.',
    );
    this.name = 'ScannerUnsupported';
  }
}

export class CameraDenied extends Error {
  constructor() {
    super('Sem acesso à câmera. Autorize nas configurações do navegador ou cole o código.');
    this.name = 'CameraDenied';
  }
}

export interface ScanHandle {
  /** Encerra a câmera. Chamar sempre — inclusive no desmonte do componente. */
  stop(): void;
}

/**
 * Liga a câmera e chama `onResult` na primeira leitura.
 *
 * A câmera é desligada assim que algo é lido: manter o vídeo rodando depois
 * de o trabalho estar feito é consumo de bateria e uma luz acesa que o
 * usuário não entende.
 */
export async function scanQr(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError?: (err: Error) => void,
): Promise<ScanHandle> {
  const Detector = ctor();
  if (!Detector) throw new ScannerUnsupported();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // `environment` é a câmera traseira no celular, que é a que aponta para
      // o QR de outra pessoa.
      video: { facingMode: 'environment' },
    });
  } catch {
    throw new CameraDenied();
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play().catch(() => undefined);

  const detector = new Detector({ formats: ['qr_code'] });
  let parado = false;
  let frame = 0;

  const parar = (): void => {
    if (parado) return;
    parado = true;
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = async (): Promise<void> => {
    if (parado) return;
    try {
      const codigos = await detector.detect(video);
      const texto = codigos[0]?.rawValue?.trim();
      if (texto) {
        parar();
        onResult(texto);
        return;
      }
    } catch (err) {
      // Quadro ilegível é o caso comum e não é erro — a câmera ainda está
      // focando. Só reporta se a detecção quebrou de vez.
      if (parado) return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    frame = requestAnimationFrame(() => void tick());
  };

  frame = requestAnimationFrame(() => void tick());
  return { stop: parar };
}

export type ScannedKind = 'liquid_address' | 'pix' | 'unknown';

export interface ScannedValue {
  readonly kind: ScannedKind;
  readonly value: string;
}

/**
 * Classifica o que foi lido.
 *
 * Deliberadamente conservador: reconhece o que tem forma clara e devolve
 * `unknown` para o resto, em vez de tentar adivinhar. Adivinhar aqui
 * significa preencher o campo de destino com algo que o usuário não conferiu.
 *
 * O BR Code do Pix (EMV/BR Code) começa com `000201`; endereços Liquid têm
 * prefixo de rede. `liquidnetwork:` é o esquema de URI usado por outras
 * carteiras.
 */
export function classifyScan(raw: string): ScannedValue {
  const texto = raw.trim();

  const semEsquema = texto.replace(/^liquidnetwork:/i, '').split('?')[0] ?? texto;
  if (/^(lq1|ex1|tlq1|tex1|VJL|VT|CTE|Az|Q|G|H)/.test(semEsquema) && semEsquema.length > 25) {
    return { kind: 'liquid_address', value: semEsquema };
  }

  if (texto.startsWith('000201') || /^0002\d{2}/.test(texto)) {
    return { kind: 'pix', value: texto };
  }

  return { kind: 'unknown', value: texto };
}
