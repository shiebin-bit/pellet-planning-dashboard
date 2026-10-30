/** Display code comes from the product description, never a substring of a SAP material ID. */
export function productLabel(product: { productCode?: string; materialCode?: string; description: string }): string {
  const match = product.description.match(/\bFS\s*[-:]?\s*(\d{4,6}[A-Z]?)(?=\s|[-/]|$)/i);
  return match?.[1].toUpperCase() ?? product.productCode ?? product.materialCode ?? '';
}

export function bagWeightFromDescription(description: string): number | null {
  const match = description.match(/\b(25|50)\s*kg\b/i);
  return match ? Number(match[1]) : null;
}

export function packagingLabel({unit, bagWeightKg, description = ''}: {unit: 'Bags' | 'MT'; bagWeightKg?: number | null; description?: string}): string {
  if (unit === 'MT') return 'Bulk';
  const weight = bagWeightKg ?? bagWeightFromDescription(description);
  return weight ? `${weight}kg Bags` : 'Bags';
}
