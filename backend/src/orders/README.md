# SCRUM-42: POST /orders

Implements API Contract v2.1 section 8, including ORD-CAT-01 through ORD-CAT-08.
Uses the JWT guard from SCRUM-39, now included in dev. Reviewed against dev
6516ec3 on 2026-10-24. Includes one migration extending the existing order-item
size check to allow ONE_SIZE with a 100% multiplier.

## Request flow

1. JwtAuthGuard verifies the token; req.user.userId identifies the customer.
2. CreateOrderDto validates 1–20 lines, UUIDs, S/M/L/ONE_SIZE and 1–10 cups per
   line. The service rejects duplicate/more than three toppings as INVALID_CART.
   Extra price/owner/status fields are stripped.
3. OrdersService reads current database prices, calculates with BigInt, rounds
   size prices half-up before adding toppings, and aggregates stock across sizes
   per product.
   It verifies active category, the product's sizePolicy, and that every topping
   is available and linked to that product.
4. In one Prisma transaction it conditionally decrements stock, reserves coupon
   quota (if supplied), and inserts the order, line/topping snapshots and HELD coupon
   redemption. Any error rolls back all of these writes.
5. Controller returns 201 with PENDING status and JSON numeric prices.

Sizes use catalog multipliers S=100%, M=120%, L=140%, ONE_SIZE=100%.
STANDARD products accept only S/M/L; ONE_SIZE products accept only ONE_SIZE.
Category inactivity returns INVALID_CART; insufficient stock returns 409.
Orders expire after 15 minutes per schema.dbml. Existing active-order constraint
is respected: an unexpired PENDING/PAYMENT_FAILED blocks a second order with 409.
SCRUM-58 serializes Create Order per customer and atomically cancels/releases an
expired active Order before starting a separate transaction for the replacement.
Coupon codes are trimmed and uppercased. Percent discounts use half-up rounding,
optional maximum discount, then a subtotal cap; fixed discounts are capped at
subtotal. Validity windows are startsAt inclusive, expiresAt exclusive.

## Try it

Configure backend/.env DATABASE_URL and JWT_SECRET as described in Auth README.
Apply migrations with `npm run db:migrate` against your local development
database (including the new ONE_SIZE constraint fix), then `npm run db:generate`.
Use products/toppings from the current catalog; login via /auth/login
and use the returned token in Swagger at /api-docs (Authorize).

POST /orders with Authorization: Bearer <token>:

```json
{
  "items": [
    {
      "productId": "<real-product-UUID>",
      "size": "M",
      "toppingIds": [],
      "quantity": 2
    }
  ]
}
```

For a 45,000 VND product and 5,000 VND topping, two M cups cost
(45,000 × 1.2 + 5,000) × 2 = 118,000 VND before coupon.

## Verification

Run from backend: npm run db:generate, npm run lint, npm run build,
npm test, npm run test:e2e. Orders HTTP tests use the actual JWT guard,
controller and service with a mocked Prisma transaction; they do not prove
PostgreSQL rollback behavior.

PostgreSQL integration tests use uniquely identified fixtures and remove only
their own records. On a **disposable test database**, apply existing migrations,
set ORDERS_TEST_DATABASE_URL, then run:

```powershell
npx vitest run --config vitest.config.integration.ts test/orders.integration-spec.ts
```

These tests verify persisted snapshots, half-up size pricing, stock/quota rollback,
active-order rejection, category/topping validation and ONE_SIZE database checks.
A real test database is required; the HTTP test suite is no substitute.

Verification on 2026-10-24: 51 unit tests and 107 HTTP tests passed. An isolated
PostgreSQL 18 instance with all six migrations passed 14 integration tests
(8 Orders, 6 Auth). TypeScript, lint and build passed. Application .env and
application database were not modified during this verification.

## SCRUM-58 inventory concurrency

Shared inventory helpers aggregate and sort Product IDs, reserve stock atomically,
and release expired unpaid Orders once under an Order row lock. Cancellation,
stock release and held-coupon release commit together. A failed cleanup prevents
replacement Order creation; a committed cleanup remains effective if the new
cart is rejected. Transactions retry bounded, known-aborted lock/deadlock errors.

See [SCRUM58_Inventory_Concurrency.md](../../../docs/api/SCRUM58_Inventory_Concurrency.md)
for lock ordering, PostgreSQL integration tests, and the callable primitive for
SCRUM-59. Payment and promotion logic retain their own modules.

## SCRUM-59 Order–Payment lifecycle

OrderExpirationService now runs every minute through the Nest application
lifecycle. It scans expired unpaid Orders in small batches using the database
clock, then calls the SCRUM-58 primitive in one transaction per Order. A failed
Order rolls back independently; subsequent batches continue. Repeated/concurrent
sweeps cannot release resources twice or cancel an Order already committed PAID.

Automatic scheduling defaults to enabled, with 50 rows per batch. Configure
ORDER_EXPIRATION_ENABLED and ORDER_EXPIRATION_BATCH_SIZE in backend/.env when
needed; the unpaid Order TTL remains 15 minutes. No new migration or dependency
is required. Shutdown stops the timer and drains the active transaction before
Prisma disconnects. No Scheduler HTTP endpoint is exposed.

See [SCRUM59_Order_Payment_Lifecycle.md](../../../docs/api/SCRUM59_Order_Payment_Lifecycle.md)
for configuration, lock ordering and real lifecycle/concurrency tests. Optional
Inventory Movement audit and customer cancellation remain outside this task.
