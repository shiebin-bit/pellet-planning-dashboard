/** Display code comes from the product description, never a substring of a SAP material ID. */
export function productLabel(product: { productCode?: string; materialCode?: string; description: string }): string {
  const match = product.description.match(/\bFS\s*[-:]?\s*(\d{4,6}[A-Z]?)(?=\s|[-/]|$)/i);
  return match?.[1].toUpperCase() ?? product.productCode ?? product.materialCode ?? '';
}
