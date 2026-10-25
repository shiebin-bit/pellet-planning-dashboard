UPDATE source_orders
SET delivery_status = 'pending',
    delivery_source = NULL,
    delivery_recorded_at = NULL,
    delivery_reason = 'Legacy DONE import was production-ready, not proof of delivery.',
    needs_review = true
WHERE delivery_source = 'import';
