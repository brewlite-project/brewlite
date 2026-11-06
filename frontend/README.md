This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Coupon Application & Demo Voucher Codes (P2-22)

The Checkout / Order Confirmation drawer (`CartDrawer`) supports real-time coupon preview via `POST /coupons/preview`, order creation with `couponCode` via `POST /orders`, and zero-amount order completion (`totalVnd = 0`) via `POST /payments/zero-amount`.

- **Backend Authority**: The frontend never calculates authoritative discounts or hardcodes coupon rules. All discount amounts (`subtotalVnd`, `discountVnd`, `totalVnd`) are rendered strictly from backend responses.
- **ZERO_AMOUNT Flow**: When an order has `totalVnd = 0`, the frontend bypasses VNPay redirect and Mock Payment, calls `POST /payments/zero-amount`, and only displays payment success after the backend confirms `paymentStatus = "SUCCESS"` and `orderStatus = "PAID"`.

### Demo / Test Coupon Codes

When the backend database is seeded with the standard demo coupons, you can test the following voucher codes in the Cart / Checkout UI:

| Coupon Code | Description / Expected Behavior |
| :--- | :--- |
| `WELCOME20` | Valid percentage discount coupon (e.g., 20% off eligible subtotal). |
| `GIAM50K` | Valid fixed-amount discount coupon (`-50.000 ₫` on eligible orders). |
| `FREE100` | 100% discount coupon (`totalVnd = 0 ₫`), triggering the `ZERO_AMOUNT` payment flow (`POST /payments/zero-amount`) without redirecting to VNPay. |
| `EXPIRED10` | Expired coupon code used to verify the `expired` validation state (`400 INVALID_COUPON`). |

## Running Frontend Checks

```bash
npm run lint
npm run build
npm test
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
