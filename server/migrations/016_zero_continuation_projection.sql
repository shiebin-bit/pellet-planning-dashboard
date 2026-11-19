ALTER TABLE job_continuation_reservations
  DROP CONSTRAINT IF EXISTS job_continuation_reservations_remaining_quantity_scaled_check;

ALTER TABLE job_continuation_reservations
  ADD CONSTRAINT job_continuation_reservations_remaining_quantity_scaled_check
  CHECK (remaining_quantity_scaled >= 0);
