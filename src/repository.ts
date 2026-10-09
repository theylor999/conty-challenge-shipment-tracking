import type { Db } from './db.ts';
import type { CarrierEvent, StoredEvent } from './domain/types.ts';

export interface Shipment {
  id: string;
  code: string;
  carrier: string;
  campaign_id: string | null;
  created_at: Date;
  last_refreshed_at: Date | null;
}

export interface DelayAlert {
  raised_at: Date;
  cleared_at: Date | null;
}

type Row = Record<string, unknown>;
const date = (v: unknown) => new Date(v as string);
const dateOrNull = (v: unknown) => (v == null ? null : date(v));

function toShipment(r: Row): Shipment {
  return {
    id: r.id as string,
    code: r.code as string,
    carrier: r.carrier as string,
    campaign_id: (r.campaign_id as string | null) ?? null,
    created_at: date(r.created_at),
    last_refreshed_at: dateOrNull(r.last_refreshed_at),
  };
}

function toEvent(r: Row): StoredEvent {
  return {
    id: r.id as number,
    dedup_key: r.dedup_key as string,
    ...(r.external_id ? { external_id: r.external_id as string } : {}),
    carrier: r.carrier as string,
    raw_status: r.raw_status as string,
    raw_description: r.raw_description as string,
    occurred_at: date(r.occurred_at),
    location: (r.location as string | null) ?? null,
    ingested_at: date(r.ingested_at),
  };
}

export class Repository {
  constructor(private readonly db: Db) {}

  insertShipment(s: Shipment): void {
    this.db
      .prepare('INSERT INTO shipments (id, code, carrier, campaign_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.id, s.code, s.carrier, s.campaign_id, s.created_at.toISOString());
  }

  findShipment(id: string): Shipment | null {
    const r = this.db.prepare('SELECT * FROM shipments WHERE id = ?').get(id) as Row | undefined;
    return r ? toShipment(r) : null;
  }

  findShipmentByCode(code: string): Shipment | null {
    const r = this.db.prepare('SELECT * FROM shipments WHERE code = ?').get(code) as Row | undefined;
    return r ? toShipment(r) : null;
  }

  listShipments(campaignId?: string): Shipment[] {
    const rows = campaignId
      ? this.db.prepare('SELECT * FROM shipments WHERE campaign_id = ? ORDER BY created_at, id').all(campaignId)
      : this.db.prepare('SELECT * FROM shipments ORDER BY created_at, id').all();
    return (rows as Row[]).map(toShipment);
  }

  touchRefreshed(id: string, at: Date): void {
    this.db.prepare('UPDATE shipments SET last_refreshed_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  listEvents(shipmentId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at, id')
      .all(shipmentId) as Row[];
    return rows.map(toEvent);
  }

  // The UNIQUE (shipment_id, dedup_key) constraint is what makes re-polling safe;
  // ON CONFLICT DO NOTHING turns a repeat into a counted duplicate.
  insertEvents(
    shipmentId: string,
    items: ReadonlyArray<{ key: string; event: CarrierEvent }>,
    ingestedAt: Date,
  ): { inserted: number; duplicates: number } {
    const stmt = this.db.prepare(
      `INSERT INTO shipment_events
         (shipment_id, dedup_key, external_id, carrier, raw_status, raw_description, occurred_at, location, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shipment_id, dedup_key) DO NOTHING`,
    );
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const { key, event } of items) {
        const res = stmt.run(
          shipmentId,
          key,
          event.external_id ?? null,
          event.carrier,
          event.raw_status,
          event.raw_description,
          event.occurred_at.toISOString(),
          event.location,
          ingestedAt.toISOString(),
        );
        inserted += Number(res.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { inserted, duplicates: items.length - inserted };
  }

  getAlert(shipmentId: string): DelayAlert | null {
    const r = this.db.prepare('SELECT * FROM delay_alerts WHERE shipment_id = ?').get(shipmentId) as Row | undefined;
    return r ? { raised_at: date(r.raised_at), cleared_at: dateOrNull(r.cleared_at) } : null;
  }

  insertAlert(shipmentId: string, raisedAt: Date): void {
    this.db
      .prepare('INSERT INTO delay_alerts (shipment_id, raised_at) VALUES (?, ?)')
      .run(shipmentId, raisedAt.toISOString());
  }

  setAlertCleared(shipmentId: string, clearedAt: Date | null): void {
    this.db
      .prepare('UPDATE delay_alerts SET cleared_at = ? WHERE shipment_id = ?')
      .run(clearedAt?.toISOString() ?? null, shipmentId);
  }
}
