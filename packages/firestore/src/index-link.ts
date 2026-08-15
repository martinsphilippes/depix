/**
 * Monta o link de "criar índice" do console do Firebase.
 *
 * Serve a um caso concreto: a chave `firebase-adminsdk` sabe ler e escrever
 * dados, mas **não** pode criar índices — são permissões distintas. Quando o
 * dono do projeto não quer (ou não pode) mexer no IAM, o caminho que sobra é
 * criar os índices pelo console, logado como pessoa. Este módulo transforma
 * `firestore.indexes.json` em links de um clique, para não depender de
 * transcrever campo por campo à mão vinte vezes.
 *
 * O parâmetro `create_composite` é um `Index` do protobuf da API de
 * administração do Firestore, serializado e em base64. Não é formato
 * documentado: foi obtido decodificando o link que o próprio Firestore
 * devolve no erro FAILED_PRECONDITION, e a codificação daqui é conferida
 * contra aquele link real em index-link.test.ts. Se o formato mudar, é o
 * teste que avisa.
 */

export type IndexOrder = 'ASCENDING' | 'DESCENDING';

export interface IndexFieldSpec {
  readonly fieldPath: string;
  readonly order?: IndexOrder;
  readonly arrayConfig?: 'CONTAINS';
}

export interface IndexSpec {
  readonly collectionGroup: string;
  readonly queryScope?: 'COLLECTION' | 'COLLECTION_GROUP';
  readonly fields: readonly IndexFieldSpec[];
}

// --- protobuf, o mínimo necessário -----------------------------------------
// Só campos de tamanho conhecido e varints de um byte aparecem aqui; escrever
// isso à mão é menos custoso do que uma dependência de runtime protobuf.

function varint(valor: number): Buffer {
  const bytes: number[] = [];
  let n = valor;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

/** Campo length-delimited (wire type 2). */
function delimitado(campo: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((campo << 3) | 2), varint(payload.length), payload]);
}

/** Campo varint (wire type 0). */
function numerico(campo: number, valor: number): Buffer {
  return Buffer.concat([varint((campo << 3) | 0), varint(valor)]);
}

const ORDEM = { ASCENDING: 1, DESCENDING: 2 } as const;
const ESCOPO = { COLLECTION: 1, COLLECTION_GROUP: 2 } as const;

function campoIndice(f: IndexFieldSpec): Buffer {
  const partes = [delimitado(1, Buffer.from(f.fieldPath, 'utf8'))];

  if (f.arrayConfig) {
    partes.push(numerico(3, 1)); // arrayConfig = CONTAINS
  } else {
    partes.push(numerico(2, ORDEM[f.order ?? 'ASCENDING']));
  }

  return delimitado(3, Buffer.concat(partes));
}

/**
 * O `__name__` fecha todo índice composto e não vem no arquivo de
 * configuração — o Firestore o acrescenta sozinho, herdando a direção do
 * último campo ordenado. Reproduzir isso importa: com a direção errada, o
 * console monta um índice diferente do que a consulta precisa, e o erro só
 * reaparece em produção.
 */
function direcaoDoNome(fields: readonly IndexFieldSpec[]): IndexOrder {
  for (let i = fields.length - 1; i >= 0; i--) {
    const ordem = fields[i]?.order;
    if (ordem) return ordem;
  }
  return 'ASCENDING';
}

/** O payload base64 do parâmetro `create_composite`. */
export function encodeCompositeIndex(projectId: string, indice: IndexSpec): string {
  const caminho =
    `projects/${projectId}/databases/(default)` +
    `/collectionGroups/${indice.collectionGroup}/indexes/_`;

  const corpo = Buffer.concat([
    delimitado(1, Buffer.from(caminho, 'utf8')),
    numerico(2, ESCOPO[indice.queryScope ?? 'COLLECTION']),
    ...indice.fields.map(campoIndice),
    campoIndice({ fieldPath: '__name__', order: direcaoDoNome(indice.fields) }),
  ]);

  // Sem o preenchimento `=`: é assim que o Firestore emite o link, e o `=`
  // ainda teria de ser escapado na URL.
  return corpo.toString('base64').replace(/=+$/, '');
}

/** URL que abre o console já com o índice preenchido, pronto para confirmar. */
export function indexConsoleLink(projectId: string, indice: IndexSpec): string {
  const payload = encodeCompositeIndex(projectId, indice);
  return (
    `https://console.firebase.google.com/v1/r/project/${projectId}` +
    `/firestore/indexes?create_composite=${payload}`
  );
}
