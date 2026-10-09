import { randomUUID } from 'node:crypto';
import type { Clock } from './clock.ts';
import { limitFor, type DomainConfig } from './config.ts';
import { assessDelay } from './domain/delay.ts';
import { dedupKey } from './domain/event-key.ts';
import { normalizeStatus, SUPPORTED_CARRIERS } from './domain/normalize.ts';
import { compareEvents, project } from './domain/projection.ts';
import { STATUS_LABELS, type CarrierEvent, type Status, type StoredEvent } from './domain/types.ts';
import { AppError } from './errors.ts';
import { ProviderError, type TrackingProvider } from './provider/provider.ts';
import type { Repository, Shipment } from './repository.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface EventView {
  occurred_at: string;
  status: Status;
  raw_status: string;
  raw_description: string;
  location: string | null;
  ingested_at: string;
}

export interface ShipmentView {
  id: string;
  code: string;
  carrier: string;
  campaign_id: string | null;
  status: Status;
  status_label: string;
  delivered_at: string | null;
  content_due_at: string | null;
  delay: {
    limit_hours: number;
    started_at: string | null;
    elapsed_hours: number | null;
    late: boolean;
    alert: { raised_at: string; cleared_at: string | null } | null;
  };
  last_refreshed_at: string | null;
  unmapped_count: number;
  history?: EventView[];
  unmapped_events?: EventView[];
}

export interface RefreshSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
}

export interface DelayAlertNotice {
  shipment_id: string;
  code: string;
  carrier: string;
  started_at: string;
  elapsed_hours: number;
  limit_hours: number;
}

export interface ServiceDeps {
  repo: Repository;
  provider: TrackingProvider;
  clock: Clock;
  config: DomainConfig;
  onDelayAlert?: (notice: DelayAlertNotice) => void;
}

const CODE_PATTERNS: Record<string, RegExp> = { correios: /^[A-Z]{2}\d{9}[A-Z]{2}$/ };
const GENERIC_CODE = /^[A-Z0-9-]{5,40}$/;

const round2 = (n: number) => Math.round(n * 100) / 100;

export class ShipmentService {
  constructor(private readonly deps: ServiceDeps) {}

  async register(input: {
    code: unknown;
    carrier: unknown;
    campaign_id?: unknown;
  }): Promise<{ shipment: ShipmentView; created: boolean }> {
    const carrier = typeof input.carrier === 'string' ? input.carrier.trim().toLowerCase() : '';
    if (!SUPPORTED_CARRIERS.includes(carrier)) {
      throw new AppError('validation', `carrier must be one of: ${SUPPORTED_CARRIERS.join(', ')}`);
    }
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!(CODE_PATTERNS[carrier] ?? GENERIC_CODE).test(code)) {
      throw new AppError('validation', `code is not a valid ${carrier} tracking code`);
    }
    const campaignId = input.campaign_id ?? null;
    if (campaignId !== null && (typeof campaignId !== 'string' || !campaignId.trim() || campaignId.length > 100)) {
      throw new AppError('validation', 'campaign_id must be a non-empty string up to 100 characters');
    }

    const existing = this.deps.repo.findShipmentByCode(code);
    if (existing) {
      if (existing.carrier !== carrier || (campaignId !== null && existing.campaign_id !== campaignId)) {
        throw new AppError('conflict', 'code is already registered with another carrier or campaign');
      }
      return { shipment: this.view(existing, true), created: false };
    }

    // Provider first: if it refuses, nothing is stored locally.
    await this.deps.provider.register(code, carrier);
    const shipment: Shipment = {
      id: randomUUID(),
      code,
      carrier,
      campaign_id: campaignId,
      created_at: this.deps.clock.now(),
      last_refreshed_at: null,
    };
    this.deps.repo.insertShipment(shipment);
    return { shipment: this.view(shipment, true), created: true };
  }

  get(id: string): ShipmentView {
    return this.view(this.require(id), true);
  }

  list(filter: { late?: boolean; campaign_id?: string }): ShipmentView[] {
    const views = this.deps.repo.listShipments(filter.campaign_id).map((s) => this.view(s, false));
    return filter.late === undefined ? views : views.filter((v) => v.delay.late === filter.late);
  }

  async refresh(id: string): Promise<{ shipment: ShipmentView; refresh: RefreshSummary }> {
    const shipment = this.require(id);
    let events: CarrierEvent[];
    try {
      events = await this.deps.provider.fetchEvents(shipment.code);
    } catch (err) {
      // An unreachable aggregator must not hide a package that is already late.
      this.syncAlert(shipment);
      throw err;
    }
    const refresh = this.ingest(shipment, events);
    return { shipment: this.view(shipment, true), refresh };
  }

  ingestWebhook(code: string, events: CarrierEvent[]): RefreshSummary | null {
    const shipment = this.deps.repo.findShipmentByCode(code.trim().toUpperCase());
    return shipment ? this.ingest(shipment, events) : null;
  }

  // Poll every shipment that is not delivered, then re-check delay with the current clock.
  async scan(): Promise<{ checked: number; failed: number }> {
    let checked = 0;
    let failed = 0;
    for (const shipment of this.deps.repo.listShipments()) {
      if (this.analyze(shipment).status === 'delivered') continue;
      checked += 1;
      try {
        await this.refresh(shipment.id);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        failed += 1;
      }
    }
    return { checked, failed };
  }

  private require(id: string): Shipment {
    const shipment = this.deps.repo.findShipment(id);
    if (!shipment) throw new AppError('not_found', 'shipment not found');
    return shipment;
  }

  private ingest(shipment: Shipment, events: CarrierEvent[]): RefreshSummary {
    const now = this.deps.clock.now();
    const items = events.map((event) => ({ key: dedupKey(shipment.code, event), event }));
    const { inserted, duplicates } = this.deps.repo.insertEvents(shipment.id, items, now);
    this.deps.repo.touchRefreshed(shipment.id, now);
    shipment.last_refreshed_at = now;
    this.syncAlert(shipment);
    return { fetched: events.length, inserted, duplicates };
  }

  private analyze(shipment: Shipment) {
    const stored = this.deps.repo.listEvents(shipment.id);
    const classified = stored
      .map((e) => ({ ...e, status: normalizeStatus(e.carrier, e.raw_status) }))
      .sort((a, b) => compareEvents(a, b) || a.id - b.id);
    const { status, delivered_at } = project(classified);
    const delay = assessDelay(
      classified,
      delivered_at,
      limitFor(this.deps.config, shipment.carrier),
      this.deps.clock.now(),
    );
    return { classified, status, delivered_at, delay };
  }

  // Alert is one row per shipment: raised once, cleared when the shipment turns out
  // not to be late (a delivery inside the limit that we learned about after the
  // limit passed), reopened silently if it becomes late again.
  private syncAlert(shipment: Shipment): void {
    const { delay } = this.analyze(shipment);
    const alert = this.deps.repo.getAlert(shipment.id);
    const now = this.deps.clock.now();
    if (delay.late && !alert) {
      this.deps.repo.insertAlert(shipment.id, now);
      this.deps.onDelayAlert?.({
        shipment_id: shipment.id,
        code: shipment.code,
        carrier: shipment.carrier,
        started_at: delay.started_at!.toISOString(),
        elapsed_hours: round2(delay.elapsed_ms! / HOUR_MS),
        limit_hours: delay.limit_hours,
      });
    } else if (delay.late && alert?.cleared_at) {
      this.deps.repo.setAlertCleared(shipment.id, null);
    } else if (!delay.late && alert && !alert.cleared_at) {
      this.deps.repo.setAlertCleared(shipment.id, now);
    }
  }

  private view(shipment: Shipment, detail: boolean): ShipmentView {
    const { classified, status, delivered_at, delay } = this.analyze(shipment);
    const alert = this.deps.repo.getAlert(shipment.id);
    const toView = (e: StoredEvent & { status: Status }): EventView => ({
      occurred_at: e.occurred_at.toISOString(),
      status: e.status,
      raw_status: e.raw_status,
      raw_description: e.raw_description,
      location: e.location,
      ingested_at: e.ingested_at.toISOString(),
    });
    const unmapped = classified.filter((e) => e.status === 'unknown');
    const contentDays = this.deps.config.contentDaysAfterDelivery;

    return {
      id: shipment.id,
      code: shipment.code,
      carrier: shipment.carrier,
      campaign_id: shipment.campaign_id,
      status,
      status_label: STATUS_LABELS[status],
      delivered_at: delivered_at?.toISOString() ?? null,
      content_due_at: delivered_at ? new Date(delivered_at.getTime() + contentDays * DAY_MS).toISOString() : null,
      delay: {
        limit_hours: delay.limit_hours,
        started_at: delay.started_at?.toISOString() ?? null,
        elapsed_hours: delay.elapsed_ms === null ? null : round2(delay.elapsed_ms / HOUR_MS),
        late: delay.late,
        alert: alert
          ? { raised_at: alert.raised_at.toISOString(), cleared_at: alert.cleared_at?.toISOString() ?? null }
          : null,
      },
      last_refreshed_at: shipment.last_refreshed_at?.toISOString() ?? null,
      unmapped_count: unmapped.length,
      ...(detail ? { history: classified.map(toView), unmapped_events: unmapped.map(toView) } : {}),
    };
  }
}
