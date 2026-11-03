/** SCRUM-80 PR #120: repeatable Phase 1 -> Phase 2 migration verification.
 * Run from any cwd: node scripts/scrum80/run_phase1_upgrade.mjs
 * Optional explicit reset ONLY on isolated legacy test DB: --reset-legacy-db
 * Windows PowerShell / Git Bash share the same Node entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const BACKEND=path.join(ROOT,'backend');
const COMPOSE=path.join(ROOT,'compose.scrum80.test.yml');
const ENV_FILE=path.join(ROOT,'.env.scrum80.local');
const MIGRATIONS=path.join(BACKEND,'prisma/migrations');
const TESTS=path.join(BACKEND,'prisma/tests');
const TEST_DB='brewlite_scrum80_legacy_verify';
const PHASE1=[
 '20261020143341_init_product_catalog',
 '20261021153059_extend_user_order_orderitem',
 '20261022011000_scrum36_active_order_coupon_constraints',
 '20261022013000_add_coupon_redemptions',
 '20261023130000_product_catalog_schema_upgrade',
 '20261024010000_order_item_one_size_constraint',
 '20261026065408_add_payment_schema'
];
const PHASE2=[
 '20261031190000_scrum76_payment_pending_enum',
 '20261031190100_scrum76_payment_gateway_delta'
];
const reset=process.argv.slice(2).includes('--reset-legacy-db');
if(process.argv.slice(2).some(a=>!['--reset-legacy-db'].includes(a))){
 console.error('Usage: node scripts/scrum80/run_phase1_upgrade.mjs [--reset-legacy-db]');
 process.exit(2);
}
function requireFile(p){if(!fs.existsSync(p))throw Error(`Missing prerequisite: ${path.relative(ROOT,p)}`);}
function run(command,args,options={}){
 const windows=process.platform==='win32';
 const exe=windows&&command==='npx'?'npx.cmd':command;
 const r=spawnSync(exe,args,{
   cwd:options.cwd??ROOT,env:options.env??process.env,encoding:'utf8',
   input:options.input,stdio:options.input===undefined?'pipe':'pipe',
   maxBuffer:8*1024*1024,windowsHide:true,
   // CMD wrappers need shell execution on Windows, never interpolate untrusted args.
   shell:windows && command==='npx'
 });
 if(r.error)throw Error(`Cannot execute ${command}: ${r.error.message}`);
 if(r.status!==0){
   if(r.stdout)process.stderr.write(r.stdout);
   if(r.stderr)process.stderr.write(r.stderr);
   throw Error(`${command} exited ${r.status}; stopped without proceeding`);
 }
 return r;
}
function docker(args,opts={}){return run('docker',['compose','--env-file',ENV_FILE,'-f',COMPOSE,...args],opts);}
function sql(query,opts={}){
 const args=['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',opts.db??'postgres'];
 if(opts.quiet)args.push('-qAt');
 // Pass via stdin, no SQL/credentials on shell command line.
 const ret=docker([...args],{input:query});
 return ret.stdout.trim();
}
function info(m){console.log(`[SCRUM80] ${m}`);}
for(const p of [COMPOSE,ENV_FILE,path.join(BACKEND,'prisma7.config.ts'),path.join(MIGRATIONS,'migration_lock.toml'),
 ...[...PHASE1,...PHASE2].map(x=>path.join(MIGRATIONS,x,'migration.sql')),
 ...['07_phase1_mock_fixtures.sql','08_legacy_fingerprint.sql','09_assert_legacy_after_phase2.sql'].map(x=>path.join(TESTS,x))])requireFile(p);
const match=fs.readFileSync(ENV_FILE,'utf8').match(/^SCRUM80_DB_PASSWORD=([^\r\n]+)$/m);
if(!match)throw Error('Expected SCRUM80_DB_PASSWORD in root .env.scrum80.local');
const password=match[1].trim().replace(/^['"]|['"]$/g,'');
if(!password)throw Error('Empty test password');
const conn=new URL(`postgresql://postgres@127.0.0.1:55480/${TEST_DB}`);
conn.password=password;
conn.searchParams.set('schema','public');
if(conn.hostname!=='127.0.0.1'||conn.port!=='55480'||conn.pathname!==`/${TEST_DB}`)throw Error('Incorrect DATABASE_URL');
const prismaEnv={...process.env,DATABASE_URL:conn.toString()};
const runPrisma=(args)=>run('npx',['prisma',...args],{cwd:BACKEND,env:prismaEnv});
let tempMigrations=null, tempConfig=null;
try{
  const services=docker(['config','--services']).stdout.split(/\r?\n/).map(x=>x.trim());
  if(!services.includes('postgres'))throw Error('Compose postgres service missing');
  const target=sql('SELECT current_database();',{quiet:true});
  if(target!=='postgres')throw Error(`Compose target not postgres admin DB: ${target}`);
  // Confirm that the mapped port is the test compose's intended port, not local PG.
  const portOutput=docker(['port','postgres','5432']).stdout.trim();
  if(!/(127\.0\.0\.1|localhost):55480\b/.test(portOutput))throw Error(`Unsafe postgres port mapping: ${portOutput}`);
  const exists=sql(`SELECT 1 FROM pg_database WHERE datname='${TEST_DB}';`,{quiet:true});
  if(exists==='1'&&!reset)throw Error(`Dedicated DB ${TEST_DB} already exists. To explicitly recreate it, pass --reset-legacy-db. Never reset shared DBs.`);
  if(exists==='1'&&reset){
    info(`Explicit isolated test DB reset requested: ${TEST_DB}`);
    sql(`DROP DATABASE "${TEST_DB}" WITH (FORCE);`);
  }
  sql(`CREATE DATABASE "${TEST_DB}";`);
  info(`Safety preflight PASS: isolated Docker PostgreSQL 127.0.0.1:55480 / ${TEST_DB}`);

  tempMigrations=fs.mkdtempSync(path.join(BACKEND,'prisma','.scrum80-phase1-'));
  for(const name of PHASE1){
    const dir=path.join(tempMigrations,name);fs.mkdirSync(dir);
    fs.copyFileSync(path.join(MIGRATIONS,name,'migration.sql'),path.join(dir,'migration.sql'));
  }
  fs.copyFileSync(path.join(MIGRATIONS,'migration_lock.toml'),path.join(tempMigrations,'migration_lock.toml'));
  tempConfig=path.join(BACKEND,`.scrum80-phase1-${process.pid}.config.ts`);
  const relativePath=`prisma/${path.basename(tempMigrations)}`;
  fs.writeFileSync(tempConfig,
`import { defineConfig } from 'prisma/config';\nexport default defineConfig({\n  schema: 'prisma/schema.prisma',\n  migrations: { path: '${relativePath}' },\n  datasource: { url: process.env.DATABASE_URL },\n});\n`);

  info('Deploy 7 Phase 1 migrations');
  runPrisma(['migrate','deploy','--config',path.basename(tempConfig)]);
  const countPhase1=sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,{db:TEST_DB,quiet:true});
  if(countPhase1!=='7')throw Error(`Expected exactly 7 applied migrations; got ${countPhase1}`);
  info('Insert Phase 1 legacy Mock FAILED/SUCCESS fixtures');
  sql(fs.readFileSync(path.join(TESTS,'07_phase1_mock_fixtures.sql'),'utf8'),{db:TEST_DB});
  const fingerprintSQL=fs.readFileSync(path.join(TESTS,'08_legacy_fingerprint.sql'),'utf8');
  const before=sql(fingerprintSQL,{db:TEST_DB,quiet:true});
  if(before.split(/\r?\n/).filter(Boolean).length!==3)throw Error('Expected exactly 3 baseline fingerprints');
  info('Saved three Phase 1-only fingerprints (not payment payloads)');

  // Preflight guard BEFORE applying Phase 2 against the only allowable target DB.
  const p2Guard=sql(`DO $$ BEGIN IF current_database() <> '${TEST_DB}' THEN RAISE EXCEPTION 'Wrong target DB'; END IF;
     IF (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 7
     THEN RAISE EXCEPTION 'Expected Phase 1 baseline'; END IF;
     IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='provider')
     THEN RAISE EXCEPTION 'Phase 2 already applied'; END IF;
     END $$;`,{db:TEST_DB});
  info('Pre-migrate target DB and Phase 1 baseline guard PASS');
  info('Apply the exact 2 SCRUM-76 migrations from repository (no migration edits)');
  runPrisma(['migrate','deploy','--config','prisma7.config.ts']);
  runPrisma(['migrate','status','--config','prisma7.config.ts']);
  const countP2=sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,{db:TEST_DB,quiet:true});
  if(countP2!=='9')throw Error(`Expected 9 applied migrations, got ${countP2}`);
  sql(fs.readFileSync(path.join(TESTS,'09_assert_legacy_after_phase2.sql'),'utf8'),{db:TEST_DB});
  const after=sql(fingerprintSQL,{db:TEST_DB,quiet:true});
  if(before!==after)throw Error('Legacy Payment fingerprints differ after upgrade!');
  info('PASS: 7 -> 9 migrations; 3/3 Mock fingerprints unchanged; provider and updated_at backfill verified');
  info('Non-destructive rerun check');
  runPrisma(['migrate','deploy','--config','prisma7.config.ts']);
  info('PASS: Phase 1 -> Phase 2 upgrade verified on isolated Docker PostgreSQL');
}finally{
  if(tempConfig&&fs.existsSync(tempConfig))fs.rmSync(tempConfig);
  if(tempMigrations&&fs.existsSync(tempMigrations))fs.rmSync(tempMigrations,{recursive:true,force:true});
}
