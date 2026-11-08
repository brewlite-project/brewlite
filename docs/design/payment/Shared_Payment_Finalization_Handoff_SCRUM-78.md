# Shared Payment Finalization Handoff (SCRUM-78)

This document describes the internal boundary implemented by
`PaymentFinalizationService`. It follows the task-confirmed normative baseline
in API Contract v4.0 §§14.2, 14.3, 14.5 and Appendix D. The Contract header
still says `NOT APPROVED`; this handoff does not change or imply document
approval.

## Service contract

```ts
finalizeInTransaction(
  tx: Prisma.TransactionClient,
  command: FinalizationCommand,
): Promise<FinalizationResult>
```

The caller starts and commits the transaction. Finalization does not open a
transaction, perform network I/O, or accept a client-reported payment result.
It locks the persisted Order, reads its state and amount again, obtains the DB
clock and persisted `expiresAt`, then locks a VNPay Payment attempt if needed.
Errors must escape to the transaction owner so the complete transaction rolls
back.

## Who verifies what

| Caller | Work before finalization | Command |
| --- | --- | --- |
| Mock `PaymentsService` | Authenticate and authorize owner; validate DTO/key; compute request hash; return an existing idempotency replay; acquire user/key advisory lock; lock Order; evaluate Mock outcome using validated server-side input. | `provider: 'MOCK'`, user/order/payment IDs, idempotency key/hash, method, server-created Mock outcome and response identifiers. |
| ZERO_AMOUNT endpoint (future caller) | Authenticate and authorize owner; validate idempotency key/hash and replay; acquire user/key serialization; start the transaction. Do not derive amount from the request. | `provider: 'ZERO_AMOUNT'`, user/order/payment IDs, idempotency key and request hash. Finalization checks persisted Order total is zero, expiry, attempts/exceptions and provider shape. |
| VNPay IPN adapter (future caller) | Outside the transaction, validate HMAC, configured merchant, transaction reference, response/status mapping and amount. Normalize only verified fields; never pass raw callback data. | `provider: 'VNPAY'`, Payment ID and `VerifiedGatewayOutcome`. |
| QueryDR worker (future caller) | Claim and lease in a short transaction; perform HTTP outside all DB transactions; verify merchant/correlation/response and normalize. Keep the original QueryDR request ID. | Same VNPay command. A late verified result is still submitted even if its lease expired; finalization rechecks persisted Payment/Order state. |

**Handoff by owner:** HKhang's IPN/QueryDR adapters should construct
`VerifiedGatewayOutcome` only after gateway verification and map the committed
disposition to the documented gateway response. CKhang's ZERO_AMOUNT route
should call this service inside its own transaction; its cleanup/Create Order
work should continue using the shared expiration primitive rather than add a
second cancellation path.

The VNPay adapter is responsible for proving the signature and mapping gateway
fields. `VerifiedGatewayOutcome` is an internal TypeScript boundary, not a
cryptographic proof by itself. Only the verifier/worker may construct it.
Finalization independently checks persisted provider, Payment↔Order identity,
owner and amount, TxnRef/TMN code, event identity shape, required gateway
fields, success codes, and timestamp validity.

## Lock and transaction order

1. Customer initiators authorize owner before exposing replay state, then
   serialize `(userId, idempotencyKey)` before the Order lock.
2. All finalizers lock Order first. VNPay performs a non-locking Payment→Order
   identity lookup, locks that Order, then locks and re-reads the Payment.
3. Finalization checks persisted Order status, total, expiry, financial
   exception flags and other accepted SUCCESS rows while the Order is locked.
4. Coupon consumption, loyalty award, Payment/Order update and gateway event
   insert run in this same transaction. Inventory is not decremented at
   payment time. Cancellation uses the shared Order-lock-held
   `cancelLockedOrderAndReleaseInTransaction` primitive, then restores products
   in sorted ID order and releases the held coupon atomically.
5. IPN/QueryDR HTTP work and transaction boundaries belong to their adapters;
   no network wait may occur while holding the Order or Payment locks.

Expiration cleanup uses `expireOrderInTransaction` under the same Order-first
lock order. It reads DB time and persisted expiry after locking; a pending
VNPay attempt keeps the Order active only while `dbNow < G`, with
`G = expiresAt + 5 minutes`.

## Result dispositions

`FinalizationResult.disposition` is a domain result, not an HTTP status:

- `FINALIZED`: the caller-owned transaction contains the terminal Mock,
  ZERO_AMOUNT, or verified VNPay result.
- `DUPLICATE`: the same idempotency request or gateway outcome has already
  been accepted/observed for that attempt. Return the stored Mock/zero
  snapshot where applicable; do not repeat coupon, points, inventory, Order
  or Payment effects.
- `OBSERVED`: verified UNKNOWN or not-yet-decidable evidence was persisted.
  Keep Payment non-terminal and do not infer failure. Reconciliation scheduling
  remains the worker's responsibility. For an `OBSERVED` or non-terminal
  duplicate QueryDR result, release the worker's claim only with a conditional
  `claimToken` match and schedule the next query under the worker's policy;
  never let an expired worker clear a newer lease.
- `CONFLICT`: a verified FAILED event conflicts with terminal Payment state
  or another accepted SUCCESS. Evidence is committed with a review flag; the
  prior terminal status is preserved.
- `FINANCIAL_EXCEPTION`: a verified SUCCESS cannot be accepted, including
  late pay time, cancelled Order, terminal Payment conflict, or another
  accepted SUCCESS. The event is persisted with review metadata; Payment is
  not promoted to SUCCESS, Order is not revived, and coupon/loyalty effects do
  not run.

IPN must map its response only after the transaction committed. Identical
committed duplicates, DB failures and VNPay ACK mappings follow §14.5 of the
Contract; do not infer that a domain disposition is itself an ACK code.

## Timing and side effects

- Accept VNPay as `PAID` only when verified `paidAt <= persisted expiresAt`,
  `dbNow < expiresAt + 5 minutes`, the Order is still `PENDING` or
  `PAYMENT_FAILED`, and no other accepted SUCCESS or review exception exists.
- A late verified SUCCESS, CANCELLED Order, terminal conflict or competing
  SUCCESS is saved as gateway evidence and review state. Terminal Payment
  status is never overwritten. A late result after expiry follows the shared
  cancellation/release primitive; CANCELLED is never revived.
- Only accepted success consumes the Order's single HELD coupon redemption.
  `activeUsageCount` was incremented at reservation and is not incremented at
  consumption.
- Only accepted non-zero success awards `floor(totalVnd / 10000)` points, with
  a guarded atomic update against the database integer limit. ZERO_AMOUNT earns
  zero.
- All payment updates explicitly set `updatedAt` from the DB clock. Terminal or
  review transitions clear `claimToken`, `leaseExpiresAt` and `nextQueryAt`.

## ZERO_AMOUNT call shape

The future endpoint should hash the canonical validated `{ orderId }` request
using the project's idempotency convention, then own a transaction that
performs owner validation, idempotency replay/serialization and calls:

```ts
const result = await paymentFinalization.finalizeInTransaction(tx, {
  provider: 'ZERO_AMOUNT',
  userId,
  orderId,
  paymentId: randomUUID(),
  idempotencyKey,
  requestHash,
});
if (!result.zeroAmountResponse) throw new Error('Missing ZERO_AMOUNT snapshot');
```

The first result is a ZERO_AMOUNT Payment with `status=SUCCESS`, `amountVnd=0`,
`method=null`, a provider-specific response snapshot, Order `PAID`, and zero
points. It must not create `PENDING`, call Mock/VNPay, or decrement reserved
inventory again. A replay returns the immutable stored response snapshot.

## Known dependency: API-06 ZERO_AMOUNT Order History

The 119 passing PostgreSQL integration tests across six suites do **not**
include a successful `GET /orders/me` assertion for a ZERO_AMOUNT Payment.
The ZERO_AMOUNT lifecycle coverage calls Shared Finalization directly,
checks persisted Payment/Order/coupon/stock/points state and replay, and runs
fulfillment transitions. It does not establish that Order History can present
that provider successfully.

Reproduction:

1. Create an Order whose persisted `totalVnd` is zero.
2. In a test-owned transaction, call `finalizeInTransaction` with
   `provider: 'ZERO_AMOUNT'` and commit it.
3. Authenticate as the Order owner and request `GET /orders/me`.

Observed result: HTTP 500. The safe generic error envelope produced by the
Order History error handler is:

```json
{
  "statusCode": 500,
  "message": "Internal server error",
  "error": "Internal Server Error",
  "code": "INTERNAL_ERROR"
}
```

Cause: `OrdersService.getMine` selects the terminal Payment and unconditionally
passes its `responseSnapshot` to `readPaymentSnapshot`. That parser accepts
only Mock `CARD`/`WALLET` snapshots with Mock-only fields such as
`methodLast4` and `mockReference`. The ZERO_AMOUNT snapshot has its own shape
and `method: null`, so parsing throws and the history handler maps it to
`INTERNAL_ERROR`.

This is an API-06 read-model dependency, not a Shared Finalization failure.
Contract v4.0 assigns Order History/Confirmation mapping and its E2E regression
to **Lập**. That owner should add provider-aware snapshot mapping and a
regression that expects `GET /orders/me` to return 200 for a committed
ZERO_AMOUNT Payment while preserving nullable legacy fields. SCRUM-78 does not
modify the endpoint; do not interpret the 119 integration passes as evidence
that ZERO_AMOUNT history presentation succeeds.

## Deliberate boundary

This handoff does not implement VNPay URL creation, the IPN controller, a
QueryDR HTTP client, reconciliation scheduling, or the ZERO_AMOUNT HTTP
endpoint. Those callers can inject the exported service and must use the same
transaction and lock contract above.
