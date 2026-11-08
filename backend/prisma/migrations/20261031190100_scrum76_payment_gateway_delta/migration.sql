-- SCRUM-76 Phase 2 (part 2/2): expand Payment + verified gateway events.
-- DESIGN: ERD/Prisma Delta v0.2.2 CK-R01..R03; BR-01..BR-06; API Contract v4.0 Review 3 Candidate.
-- REQUIRES: Phase 1 seven migrations + committed enum PENDING migration.
-- REVIEW BEFORE APPLYING. Run on an isolated clone of the real Phase 1 DB first.
-- Avoid a surrounding BEGIN wrapping prior enum migration; no history rewriter, no DROP legacy fields.

-- PostgreSQL DDL in this migration is transactional; rollback all on a failed CHECK.
BEGIN;

CREATE TYPE "payment_provider" AS ENUM ('MOCK', 'VNPAY', 'ZERO_AMOUNT');
CREATE TYPE "payment_reconciliation_state" AS ENUM ('NONE', 'SCHEDULED', 'RESOLVED', 'REQUIRES_REVIEW');
CREATE TYPE "payment_gateway_source" AS ENUM ('IPN', 'QUERYDR');
CREATE TYPE "payment_gateway_outcome" AS ENUM ('UNKNOWN', 'SUCCESS', 'FAILED');
CREATE TYPE "payment_gateway_disposition" AS ENUM ('OBSERVED', 'FINALIZED', 'DUPLICATE', 'CONFLICT', 'FINANCIAL_EXCEPTION');

-- Safe expanding provider/backfill; intentionally NO permanent default.
ALTER TABLE "payments" ADD COLUMN "provider" "payment_provider";
UPDATE "payments" SET "provider" = 'MOCK' WHERE "provider" IS NULL;
ALTER TABLE "payments" ALTER COLUMN "provider" SET NOT NULL;

-- CK-R01: legacy Mock updated_at is unknown; created_at is the only honest fallback.
ALTER TABLE "payments" ADD COLUMN "updated_at" TIMESTAMPTZ(6);
UPDATE "payments" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "payments" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- Preserve Mock snapshot/keys/hash/status/amount; relax nullability for VNPay/zero-amount.
ALTER TABLE "payments" ALTER COLUMN "method" DROP NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "response_snapshot" DROP NOT NULL;

-- Phase 2 gateway identity and reconciliation metadata. No sensitive gateway secret.
ALTER TABLE "payments"
  ADD COLUMN "vnp_txn_ref" VARCHAR(100),
  ADD COLUMN "vnp_tmn_code" TEXT,
  ADD COLUMN "vnp_create_date" VARCHAR(14),
  ADD COLUMN "gateway_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "initiation_snapshot" JSONB,
  ADD COLUMN "final_outcome_snapshot" JSONB,
  ADD COLUMN "verified_paid_at" TIMESTAMPTZ(6),
  ADD COLUMN "verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "finalized_at" TIMESTAMPTZ(6),
  ADD COLUMN "reconciliation_state" "payment_reconciliation_state" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "next_query_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_query_at" TIMESTAMPTZ(6),
  ADD COLUMN "query_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconcile_until" TIMESTAMPTZ(6),
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_query_request_id" VARCHAR(64),
  ADD COLUMN "last_query_error" TEXT,
  ADD COLUMN "review_reason" TEXT,
  ADD COLUMN "has_financial_exception" BOOLEAN NOT NULL DEFAULT FALSE;

-- Event-only store for verified IPN/QueryDR; no raw callback/secret.
CREATE TABLE "payment_gateway_events" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "source" "payment_gateway_source" NOT NULL,
  "event_identity" VARCHAR(64) NOT NULL,
  "query_request_id" VARCHAR(64),
  "response_code" TEXT,
  "transaction_status" TEXT,
  "gateway_transaction_no" TEXT,
  "amount_vnd" BIGINT,
  "gateway_paid_at" TIMESTAMPTZ(6),
  "outcome" "payment_gateway_outcome" NOT NULL,
  "disposition" "payment_gateway_disposition" NOT NULL,
  "exception_reason" TEXT,
  "received_at" TIMESTAMPTZ(6) NOT NULL,
  "verified_at" TIMESTAMPTZ(6) NOT NULL,
  "evidence" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_gateway_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_gateway_events_payment_id_fkey" FOREIGN KEY ("payment_id")
    REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Keep the two Phase 1 partial unique indexes unchanged; do not add UNIQUE(order_id).
-- uq_payments_one_success_per_order: WHERE status = SUCCESS (ALREADY EXISTS)
-- uq_orders_one_active_per_user: WHERE status IN (PENDING, PAYMENT_FAILED) (ALREADY EXISTS)
CREATE UNIQUE INDEX "uq_payments_vnp_txn_ref" ON "payments"("vnp_txn_ref");
CREATE UNIQUE INDEX "uq_payments_one_pending_vnpay_per_order" ON "payments"("order_id")
  WHERE "provider" = 'VNPAY' AND "status" = 'PENDING';
CREATE INDEX "ix_payments_reconcile_due"
  ON "payments"("reconciliation_state", "next_query_at", "id");
CREATE INDEX "ix_payments_reconcile_horizon"
  ON "payments"("reconciliation_state", "reconcile_until", "id");
CREATE UNIQUE INDEX "uq_payment_gateway_events_identity"
  ON "payment_gateway_events"("payment_id", "source", "event_identity");
CREATE INDEX "ix_payment_gateway_events_history"
  ON "payment_gateway_events"("payment_id", "received_at", "id");

-- Payment/Event CHECKs copied exactly from reviewed DBML v0.2.2.
-- PostgreSQL CHECKs cannot enforce cross-table ownership, amount, or expiry.
-- Existing ck_payments_amount_nonnegative is retained; not re-created.
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_provider_shape" CHECK ((((provider = 'MOCK' AND method IS NOT NULL AND status IN ('SUCCESS','FAILED') AND response_snapshot IS NOT NULL) OR (provider = 'ZERO_AMOUNT' AND method IS NULL AND amount_vnd = 0 AND status = 'SUCCESS' AND response_snapshot IS NOT NULL) OR (provider = 'VNPAY' AND method IS NULL AND amount_vnd > 0 AND response_snapshot IS NULL))) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_nonmock_mask" CHECK ((provider = 'MOCK' OR (mock_reference IS NULL AND method_last4 IS NULL)) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_gateway_shape" CHECK ((((provider = 'VNPAY' AND vnp_txn_ref IS NOT NULL AND length(vnp_txn_ref) > 0 AND vnp_tmn_code IS NOT NULL AND length(vnp_tmn_code) > 0 AND vnp_create_date IS NOT NULL AND vnp_create_date ~ '^[0-9]{14}$' AND gateway_expires_at IS NOT NULL AND gateway_expires_at > created_at AND initiation_snapshot IS NOT NULL AND reconcile_until IS NOT NULL) OR (provider <> 'VNPAY' AND vnp_txn_ref IS NULL AND vnp_tmn_code IS NULL AND vnp_create_date IS NULL AND gateway_expires_at IS NULL AND initiation_snapshot IS NULL AND final_outcome_snapshot IS NULL AND verified_paid_at IS NULL AND verified_at IS NULL AND finalized_at IS NULL AND reconcile_until IS NULL))) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_vnp_terminal" CHECK ((provider <> 'VNPAY' OR ((status = 'PENDING' AND final_outcome_snapshot IS NULL AND finalized_at IS NULL AND verified_at IS NULL AND verified_paid_at IS NULL) OR (status IN ('SUCCESS','FAILED') AND final_outcome_snapshot IS NOT NULL AND finalized_at IS NOT NULL AND verified_at IS NOT NULL))) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_json_objects" CHECK (((response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object') AND (initiation_snapshot IS NULL OR jsonb_typeof(initiation_snapshot) = 'object') AND (final_outcome_snapshot IS NULL OR jsonb_typeof(final_outcome_snapshot) = 'object')) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_query_attempts" CHECK ((query_attempts >= 0) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_reconcile_shape" CHECK ((((provider <> 'VNPAY' AND reconciliation_state = 'NONE' AND next_query_at IS NULL AND review_reason IS NULL) OR (provider = 'VNPAY' AND ((reconciliation_state = 'SCHEDULED' AND status = 'PENDING' AND next_query_at IS NOT NULL AND next_query_at <= reconcile_until AND review_reason IS NULL) OR (reconciliation_state = 'RESOLVED' AND status IN ('SUCCESS','FAILED') AND next_query_at IS NULL AND review_reason IS NULL) OR (reconciliation_state = 'REQUIRES_REVIEW' AND next_query_at IS NULL AND review_reason IS NOT NULL AND length(review_reason) > 0))))) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_claim_pair" CHECK (((claim_token IS NULL AND lease_expires_at IS NULL) OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND reconciliation_state = 'SCHEDULED')) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_query_history" CHECK (((query_attempts = 0 AND last_query_at IS NULL AND last_query_request_id IS NULL AND last_query_error IS NULL) OR (provider = 'VNPAY' AND query_attempts > 0 AND last_query_at IS NOT NULL AND last_query_request_id IS NOT NULL)) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_financial_review" CHECK ((NOT has_financial_exception OR (provider = 'VNPAY' AND reconciliation_state = 'REQUIRES_REVIEW')) IS TRUE);
ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_nonvnp_reconcile_clean" CHECK ((provider = 'VNPAY' OR (query_attempts = 0 AND next_query_at IS NULL AND last_query_at IS NULL AND last_query_request_id IS NULL AND last_query_error IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL AND review_reason IS NULL AND has_financial_exception = false)) IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_identity" CHECK ((event_identity ~ '^[0-9a-f]{64}$') IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_source" CHECK (((source = 'IPN' AND query_request_id IS NULL AND amount_vnd IS NOT NULL) OR (source = 'QUERYDR' AND query_request_id IS NOT NULL)) IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_amount" CHECK ((amount_vnd IS NULL OR amount_vnd >= 0) IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_terminal_evidence" CHECK ((outcome = 'UNKNOWN' OR (amount_vnd IS NOT NULL AND response_code IS NOT NULL AND transaction_status IS NOT NULL)) IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_exception" CHECK (((disposition IN ('CONFLICT','FINANCIAL_EXCEPTION') AND exception_reason IS NOT NULL AND length(exception_reason) > 0) OR (disposition NOT IN ('CONFLICT','FINANCIAL_EXCEPTION') AND exception_reason IS NULL)) IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_evidence" CHECK ((jsonb_typeof(evidence) = 'object') IS TRUE);
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "ck_gateway_events_disposition_outcome" CHECK (((disposition = 'FINALIZED' AND outcome IN ('SUCCESS','FAILED')) OR (disposition = 'FINANCIAL_EXCEPTION' AND outcome = 'SUCCESS') OR (disposition = 'CONFLICT' AND outcome IN ('SUCCESS','FAILED')) OR disposition IN ('OBSERVED','DUPLICATE')) IS TRUE);

-- No triggers automatically touch updated_at; Backend MUST do this with DB clock.
-- IPN/QueryDR verification, append-only evidence, terminal immutability and Order-wide
-- financial exception policy are service/transaction invariants and require integration tests.
COMMIT;
