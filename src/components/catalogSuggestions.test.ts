import { describe, expect, it } from 'vitest';
import type { CatalogProduct, JobInput } from '../domain/types';
import { catalogSuggestions, shouldApplyCatalogMode } from './catalogSuggestions';

const catalog: CatalogProduct[] = [
  { id: '1', code: '6220', description: 'Starter pellet', defaultMode: 'bags', active: true },
  { id: '2', code: '6811', description: 'Finisher pellet', defaultMode: 'bulk', active: true },
  { id: '3', code: 'OLD-1', description: 'Retired starter', defaultMode: 'bags', active: false },
];

const form: JobInput = {
  date: '2026-10-20', lineId: 'PM1', orderNo: '', productCode: '', description: '', bin: '',
  mode: 'bags', bagCount: 0, quantityMt: 0, remarks: '',
};

describe('catalogSuggestions', () => {
  it('matches active products by code or description', () => {
    expect(catalogSuggestions(catalog, '681').map(product => product.id)).toEqual(['2']);
    expect(catalogSuggestions(catalog, 'starter').map(product => product.id)).toEqual(['1']);
  });

  it('excludes inactive products', () => {
    expect(catalogSuggestions(catalog, 'retired')).toEqual([]);
  });
});

describe('shouldApplyCatalogMode', () => {
  it('only applies a catalog default to an empty new task', () => {
    expect(shouldApplyCatalogMode(false, form)).toBe(true);
    expect(shouldApplyCatalogMode(true, form)).toBe(false);
    expect(shouldApplyCatalogMode(false, { ...form, bagCount: 12 })).toBe(false);
    expect(shouldApplyCatalogMode(false, { ...form, quantityMt: 3.5 })).toBe(false);
  });
});
