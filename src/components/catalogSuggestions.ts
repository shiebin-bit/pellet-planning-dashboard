import type { CatalogProduct, JobInput } from '../domain/types';

export function catalogSuggestions(
  catalog: CatalogProduct[],
  query: string,
  limit = 8,
): CatalogProduct[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  return catalog
    .filter(product => product.active)
    .filter(product =>
      product.code.toLowerCase().includes(normalized)
      || product.description.toLowerCase().includes(normalized),
    )
    .sort((left, right) => {
      const leftCode = left.code.toLowerCase();
      const rightCode = right.code.toLowerCase();
      const leftStarts = leftCode.startsWith(normalized);
      const rightStarts = rightCode.startsWith(normalized);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.code.localeCompare(right.code, undefined, { sensitivity: 'base' });
    })
    .slice(0, limit);
}

export function shouldApplyCatalogMode(editing: boolean, form: JobInput): boolean {
  if (editing) return false;
  return !(Number(form.bagCount) > 0 || Number(form.quantityMt) > 0);
}
