import type { InventoryBucketSnapshot, InventoryItemConfiguration } from '../domain/inventoryTypes';

/** Safety stock targets apply only to the standard finished-goods variant. */
export function replenishmentShortage(item: InventoryItemConfiguration, bucket: InventoryBucketSnapshot): number | null {
  if (item.strategy !== 'mts' || item.targetQuantity === null || bucket.medication || bucket.fmrOmed) return null;
  const scale = item.unit === 'Bags' ? 1 : 1000;
  return Math.max(0, Math.round((item.targetQuantity - bucket.available) * scale) / scale);
}
