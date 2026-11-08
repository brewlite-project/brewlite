# SCRUM-96 — Coupon Preview API Addendum

| Document control | Value |
|---|---|
| Status | **SCRUM-96 implementation decisions confirmed; overall API Contract approval status unchanged** |
| Scope | `POST /coupons/preview` only |
| Related contracts | BrewLite API Contract v3.0 §10 and §8.4; v4.0 §14.1 |

This addendum records the SCRUM-96 `POST /coupons/preview` scope and the
implementation decisions confirmed for this task. It does not change the
approval status of API Contract v3.0 or v4.0, rewrite their version history, or
approve unrelated Deferred APIs. Customer cancellation and other Deferred
features remain outside this scope.

## `POST /coupons/preview`

- Authentication: Bearer JWT required. The Customer identity is the verified
  JWT `sub`; `userId` is not accepted from the request as an ownership input.
- Success: HTTP `200`.
- The endpoint is read-only. It creates no Order, Payment, or CouponRedemption,
  does not reserve stock, and does not change `activeUsageCount`.
- It does not lock or reserve Product stock. `POST /orders` checks stock when it
  reserves the cart; a preview is not a stock availability guarantee.
- A successful preview is informational. `POST /orders` independently reloads
  and revalidates the coupon under the Coupon row lock; the preview is not a
  token or proof that a later Order will succeed.

### Request

```json
{
  "couponCode": " free100 ",
  "items": [
    {
      "productId": "550e8400-e29b-41d4-a716-446655440000",
      "size": "S",
      "quantity": 1,
      "toppingIds": []
    }
  ]
}
```

`couponCode` is trimmed and uppercased. `items` follows `POST /orders`: 1–20
cart lines, quantity 1–10, at most 3 unique toppings per line, and the same
`S|M|L` versus `ONE_SIZE` validation. Product/category and topping prices and
associations are loaded by the backend. Client subtotal, amount, discount,
total, `userId`, and validity flags are ignored and never used for calculation.

### Successful response

```json
{
  "couponCode": "FREE100",
  "subtotalVnd": 100000,
  "discountVnd": 100000,
  "totalVnd": 0,
  "valid": true
}
```

Amounts are non-negative JSON numbers in VND. `totalVnd = max(0, subtotalVnd -
discountVnd)`. No HTTP-success response is returned for an invalid coupon/cart.

### Validation and discount rules

- A coupon is within its time window when `startsAt <= dbNow < expiresAt`.
- Coupon validity also requires existence and `subtotalVnd >= minSubtotalVnd`.
- Global quota uses `activeUsageCount < usageLimit`; per-Customer quota counts
  only that Customer's `HELD` and `CONSUMED` redemptions. `RELEASED` does not
  count. Preview does not lock or reserve quota, so its result can become stale.
- Discount uses the existing BigInt `calculateDiscount` policy. PERCENT uses
  half-up percentage arithmetic and applies `maxDiscountVnd` when configured.
  FIXED ignores `maxDiscountVnd` and uses `min(value, subtotal)`. Neither
  discount can exceed subtotal, so `totalVnd` is never negative.
- Size pricing uses the SCRUM-96 decision aligned with API Contract v4.0 §14.1:
  `sizePriceVnd = (basePriceVnd * BigInt(multiplierPercent) + 50n) / 100n`.
  This BigInt calculation rounds half-up before adding topping prices; quantity
  is applied after the topping sum. Preview and Create Order use the same
  `priceCart` helper.
- The pricing change applies only when a new cart is priced. Existing saved
  Order/OrderItem snapshots are not recalculated. Loyalty remains
  `floor(totalVnd / 10000)` for paid totals; ZERO_AMOUNT earns 0 points. This
  task-specific choice does not change the approval status of API Contract
  v3.0 or v4.0.
- The current Coupon schema has no independent `isActive` flag. For this
  endpoint, time-window validity is the available activation rule. A separate
  enable/disable switch would require a product decision and schema migration;
  this addendum does not add one.

### Error responses

Errors use the existing JSON envelope `{ statusCode, error, code, message }`.

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | Malformed request, item count, size, UUID, or quantity |
| 400 | `INVALID_CART` | Product/category, size policy, topping relation/availability, duplicate topping, or topping count is invalid |
| 400 | `INVALID_COUPON` | Coupon missing, not started, expired, or below minimum subtotal |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 409 | `COUPON_UNAVAILABLE` | Global or per-Customer quota is exhausted |
| 500 | `INTERNAL_ERROR` | Unexpected server failure; no SQL or connection detail is returned |

## Create Order and payment lifecycle

`POST /orders` continues to own stock and coupon reservations in its existing
transaction. It rechecks coupon code/configuration, DB time, and quota after
locking the Coupon row, then creates exactly one `HELD` redemption for the
Order. Shared Payment Finalization consumes that redemption once; shared Order
expiration changes `HELD` to `RELEASED` only when the Order becomes `CANCELLED`.
No parallel lifecycle or Customer Cancel API is introduced.
