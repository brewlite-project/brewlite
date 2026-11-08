-- SCRUM-76 Phase 2 (part 1/2): commit enum value before its use in CHECK/indexes.
-- Requires 7 committed Phase 1 migrations. PostgreSQL enum value activation may
-- require a separate transaction; Prisma Migrate applies each migration separately.
ALTER TYPE "payment_status" ADD VALUE 'PENDING' BEFORE 'SUCCESS';
