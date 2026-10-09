import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../../src/domain/normalize.ts';

describe('normalizeStatus', () => {
  it.each([
    ['correios', 'PO', 'posted'],
    ['correios', 'RO', 'in_transit'],
    ['correios', 'DO', 'in_transit'],
    ['correios', 'OEC', 'out_for_delivery'],
    ['correios', 'BDE/01', 'delivered'],
    ['correios', 'BDI/01', 'delivered'],
    ['correios', 'BDR/01', 'delivered'],
    ['correios', 'LDI', 'exception'],
    ['jadlog', 'EMISSAO', 'posted'],
    ['jadlog', 'EM ROTA', 'out_for_delivery'],
    ['jadlog', 'ENTREGUE', 'delivered'],
    ['loggi', 'Saiu para entrega', 'out_for_delivery'],
    ['loggi', 'Em trânsito', 'in_transit'],
    ['loggi', 'ENTREGUE', 'delivered'],
    ['loggi', 'Destinatário ausente', 'exception'],
  ] as const)('%s %s -> %s', (carrier, raw, expected) => {
    expect(normalizeStatus(carrier, raw)).toBe(expected);
  });

  it('does not treat every BDE as delivered: only the delivery subcode is', () => {
    expect(normalizeStatus('correios', 'BDE/02')).toBe('exception');
    expect(normalizeStatus('correios', 'BDE')).toBe('unknown');
    expect(normalizeStatus('correios', 'BDE/99')).toBe('unknown');
  });

  it('is case and accent insensitive', () => {
    expect(normalizeStatus('Correios', ' bde/01 ')).toBe('delivered');
    expect(normalizeStatus('loggi', 'saiu-para-entrega')).toBe('out_for_delivery');
  });

  it('falls back to the bare code for non-delivery subcodes only', () => {
    expect(normalizeStatus('correios', 'RO/01')).toBe('in_transit');
    expect(normalizeStatus('jadlog', 'ENTREGUE/99')).toBe('unknown');
  });

  it('maps unknown codes and unknown carriers to unknown', () => {
    expect(normalizeStatus('correios', 'ZZZ')).toBe('unknown');
    expect(normalizeStatus('jadlog', 'BDE/01')).toBe('unknown');
    expect(normalizeStatus('fedex', 'DELIVERED')).toBe('unknown');
  });
});
