import type { Status } from './types.ts';

type Table = Record<string, Status>;

// Keys are `CODE` or `CODE/SUBCODE`, already in normalizeKey() form.
// Correios reuses one code with several subcodes (BDE/01 delivered, BDE/02
// recipient absent), so a delivery code is only trusted with an exact subcode.
const correios: Table = {
  PO: 'posted',
  RO: 'in_transit',
  DO: 'in_transit',
  OEC: 'out_for_delivery',
  'BDE/01': 'delivered',
  'BDI/01': 'delivered',
  'BDR/01': 'delivered',
  'BDE/02': 'exception', // destinatário ausente
  'BDI/02': 'exception',
  'BDR/02': 'exception',
  'BDE/03': 'exception', // destinatário mudou-se
  'BDI/03': 'exception',
  'BDR/03': 'exception',
  'BDE/04': 'exception', // endereço incorreto
  'BDI/04': 'exception',
  'BDR/04': 'exception',
  LDI: 'exception', // aguardando retirada: the creator does not have it yet
  FC: 'exception', // retido na fiscalização
  DEV: 'exception', // devolvido ao remetente
};

const jadlog: Table = {
  EMISSAO: 'posted',
  ENTRADA: 'in_transit',
  TRANSFERENCIA: 'in_transit',
  EM_ROTA: 'out_for_delivery',
  ENTREGUE: 'delivered',
  NAO_ENTREGUE: 'exception',
  OCORRENCIA: 'exception',
  DEVOLUCAO: 'exception',
};

const loggi: Table = {
  COLETADO: 'posted',
  EM_TRANSITO: 'in_transit',
  SAIU_PARA_ENTREGA: 'out_for_delivery',
  ENTREGUE: 'delivered',
  TENTATIVA_SEM_SUCESSO: 'exception',
  DESTINATARIO_AUSENTE: 'exception',
  DEVOLVIDO: 'exception',
};

const TABLES: Record<string, Table> = { correios, jadlog, loggi };

export const SUPPORTED_CARRIERS = Object.keys(TABLES);

// Loggi sends free text ("Saiu para entrega"); others send codes. One spelling for all.
export function normalizeKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '_');
}

// Only the carrier's status code is read. The description is never used to guess
// a status: "Objeto não entregue" and "Entrega não efetuada" both contain "entregue".
// Bare-code fallback (CODE for CODE/SUBCODE) can never produce delivered.
export function normalizeStatus(carrier: string, rawStatus: string): Status {
  const table = TABLES[carrier.trim().toLowerCase()];
  if (!table) return 'unknown';
  const key = normalizeKey(rawStatus);
  const exact = table[key];
  if (exact) return exact;
  const bare = key.split('/')[0] ?? '';
  const fallback = key.includes('/') ? table[bare] : undefined;
  return fallback && fallback !== 'delivered' ? fallback : 'unknown';
}
