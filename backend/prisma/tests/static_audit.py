"""Offline source-level review. This DOES NOT replace Prisma/PostgreSQL validation."""
from pathlib import Path
import re, hashlib
# Support both locations:
# - repository: backend/prisma/tests/static_audit.py
# - extracted review kit: tests/static_audit.py
base = Path(__file__).resolve().parent.parent
prisma_dir = base / 'backend' / 'prisma' if (base / 'backend' / 'prisma' / 'schema.prisma').is_file() else base
if not (prisma_dir / 'schema.prisma').is_file():
    raise FileNotFoundError(f'Cannot locate Prisma schema from {__file__}')

# In Git, the approved DBML lives in docs/docs_Phase2; in the kit it lives in reference/.
dbml_name = 'schema_phase2_proposed_v0.2.2_CK-R01-R03_UPDATED.dbml'
dbml_candidates = [
    base / 'reference' / dbml_name,
    prisma_dir.parent.parent / 'docs' / 'docs_Phase2' / dbml_name,
]
dbml_path = next((path for path in dbml_candidates if path.is_file()), None)
if dbml_path is None:
    raise FileNotFoundError(f'DBML not found. Checked: {dbml_candidates}')

s = (prisma_dir / 'schema.prisma').read_text(encoding='utf-8')
m1 = (prisma_dir / 'migrations' / '20261031190000_scrum76_payment_pending_enum' / 'migration.sql').read_text(encoding='utf-8')
m2 = (prisma_dir / 'migrations' / '20261031190100_scrum76_payment_gateway_delta' / 'migration.sql').read_text(encoding='utf-8')
db = dbml_path.read_text(encoding='utf-8')
pre = (prisma_dir / 'migrations' / '20261026065408_add_payment_schema' / 'migration.sql').read_text(encoding='utf-8')
assert len(re.findall(r'^model\s+\w+\s*\{',s,re.M))==12
assert 'model PaymentGatewayEvent {' in s and 'enum PaymentProvider {' in s
assert 'PENDING' in s.split('enum PaymentStatus {',1)[1].split('}',1)[0]
assert 'updatedAt' in s.split('model Payment {',1)[1]
assert '@updatedAt' not in s.split('model Payment {',1)[1].split('model PaymentGatewayEvent {',1)[0].replace('no Prisma @updatedAt','')
assert s.count('@@unique([userId, idempotencyKey]')==1
assert 'CREATE UNIQUE INDEX "uq_payments_one_success_per_order"' in pre
assert 'CREATE UNIQUE INDEX "uq_payments_one_pending_vnpay_per_order"' in m2
assert 'WHERE "provider" = \'VNPAY\' AND "status" = \'PENDING\'' in m2
assert 'DROP INDEX' not in m2 and 'DROP TABLE' not in m2 and 'UPDATE "payments" SET "response_snapshot"' not in m2
assert 'ALTER TYPE "payment_status" ADD VALUE \'PENDING\' BEFORE \'SUCCESS\'' in m1
for col in ['provider','updated_at','vnp_txn_ref','vnp_tmn_code','gateway_expires_at','query_attempts','has_financial_exception']:
 assert col in m2, col
for table in ('payments','payment_gateway_events'):
 raw=db.split('Table '+table+' {',1)[1].split('\n}',1)[0]
 block=raw.split('  checks {',1)[1].split('\n  }',1)[0]
 found=re.findall(r'^\s*`(.+?)` \[name: \'([^\']+)\'\]',block,re.M)
 for expr,name in found:
  if name=='ck_payments_amount_nonnegative':
   assert '"ck_payments_amount_nonnegative"' in pre
  else:
   line=f'ALTER TABLE "{table}" ADD CONSTRAINT "{name}" CHECK ({expr});'
   assert line in m2, f'{name} SQL differs from DBML'
 print(f'{table} CHECKs match DBML:',len(found))
for enum in ['payment_provider','payment_reconciliation_state','payment_gateway_source','payment_gateway_outcome','payment_gateway_disposition']:
 assert f'CREATE TYPE "{enum}"' in m2
print('Schema: 12 models; legacy partial unique kept; 2 new migrations; phase2 CHECK text same as DBML: PASS')
print('Full Prisma validate, PostgreSQL migration and integration testing: NOT RUN HERE')
