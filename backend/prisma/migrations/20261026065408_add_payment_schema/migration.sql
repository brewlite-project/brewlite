-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CARD', 'WALLET');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "request_hash" VARCHAR(128) NOT NULL,
    "amount_vnd" BIGINT NOT NULL,
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL,
    "mock_reference" VARCHAR(255),
    "method_last4" VARCHAR(4),
    "response_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_payments_order_id" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payments_user_idempotency" ON "payments"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One successful payment per order.
CREATE UNIQUE INDEX "uq_payments_one_success_per_order"
ON "payments" ("order_id")
WHERE "status" = 'SUCCESS';

-- Payment amount must be non-negative.
ALTER TABLE "payments"
ADD CONSTRAINT "ck_payments_amount_nonnegative"
CHECK ("amount_vnd" >= 0);