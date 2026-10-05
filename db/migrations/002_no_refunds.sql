ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_payment_status_check;
ALTER TABLE reservations
  ADD CONSTRAINT reservations_payment_status_check
  CHECK (payment_status IN ('unpaid','pending','part_paid','paid'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','settled','failed'));

ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_status_check;
ALTER TABLE pos_orders
  ADD CONSTRAINT pos_orders_status_check
  CHECK (status IN ('paid','voided'));
