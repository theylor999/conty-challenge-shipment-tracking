export const STATUSES = [
  'posted',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  posted: 'postado',
  in_transit: 'em trânsito',
  out_for_delivery: 'saiu para entrega',
  delivered: 'entregue',
  exception: 'exceção',
  unknown: 'desconhecido',
};

// What every provider adapter must produce. Nothing aggregator-specific lives here.
export interface CarrierEvent {
  external_id?: string;
  carrier: string;
  raw_status: string;
  raw_description: string;
  occurred_at: Date;
  location: string | null;
}

export interface StoredEvent extends CarrierEvent {
  id: number;
  dedup_key: string;
  ingested_at: Date;
}
