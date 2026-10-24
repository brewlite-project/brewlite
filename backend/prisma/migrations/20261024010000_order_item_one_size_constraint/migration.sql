-- API Contract v2.1: ONE_SIZE products have the same 100% multiplier as S.
-- Keep historical migrations immutable; extend the existing check in place.
ALTER TABLE "order_items"
DROP CONSTRAINT "ck_order_items_size_percent";

ALTER TABLE "order_items"
ADD CONSTRAINT "ck_order_items_size_percent"
CHECK (
  ("size" = 'S' AND "size_percent_snapshot" = 100)
  OR ("size" = 'M' AND "size_percent_snapshot" = 120)
  OR ("size" = 'L' AND "size_percent_snapshot" = 140)
  OR ("size" = 'ONE_SIZE' AND "size_percent_snapshot" = 100)
);
