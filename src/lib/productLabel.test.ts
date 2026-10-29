import { describe, expect, it } from 'vitest';
import { productLabel } from './productLabel';

describe('production product labels', () => {
  it('reads the FS code from the description without slicing the material ID', () => {
    expect(productLabel({ productCode: '7.0312008522000', description: 'FS 5220 BROILER FIN PELLET II IN BULK' })).toBe('5220');
    expect(productLabel({ materialCode: '7.0312008522000', description: 'FS 5101 STARTER 25KG' })).toBe('5101');
    expect(productLabel({ productCode: '7.0312008522000', description: 'fs 5220A Feed' })).toBe('5220A');
  });
  it('retains manual codes and full material IDs when the description has no FS code', () => {
    expect(productLabel({ productCode: '6220-DEMO', description: 'Demo feed' })).toBe('6220-DEMO');
    expect(productLabel({ productCode: '7.0312008522000', description: '5220 BROILER' })).toBe('7.0312008522000');
    expect(productLabel({ productCode: '7.0312008522000', description: 'Contains 50KG and 2026' })).toBe('7.0312008522000');
  });
});
