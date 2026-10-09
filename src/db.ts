import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Timestamps are ISO-8601 UTC strings with milliseconds, so text order is time order.
// Normalized status is deliberately not stored: it is derived from raw_status on read,
// so adding a mapping fixes already-ingested events.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  carrier TEXT NOT NULL,
  campaign_id TEXT,
  created_at TEXT NOT NULL,
  last_refreshed_at TEXT
);

CREATE TABLE IF NOT EXISTS shipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  dedup_key TEXT NOT NULL,
  external_id TEXT,
  carrier TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  raw_description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  location TEXT,
  ingested_at TEXT NOT NULL,
  UNIQUE (shipment_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_events_shipment ON shipment_events (shipment_id, occurred_at);

CREATE TABLE IF NOT EXISTS delay_alerts (
  shipment_id TEXT PRIMARY KEY REFERENCES shipments(id),
  raised_at TEXT NOT NULL,
  cleared_at TEXT
);
`;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
