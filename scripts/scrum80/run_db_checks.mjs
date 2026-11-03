/** SCRUM80 P2-06 positive/negative SQL verification on isolated Docker Postgres.
 * Works on Git Bash / PowerShell: node scripts/scrum80/run_db_checks.mjs
 * Option: --legacy for the standalone Phase1->Phase2 upgraded test database.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cliArgs=process.argv.slice(2);
const legacy=cliArgs.includes('--legacy');
if(cliArgs.some(x=>x!=='--legacy') || cliArgs.length > 1){console.error('Usage: node scripts/scrum80/run_db_checks.mjs [--legacy]');process.exit(2);}
const db=legacy?'brewlite_scrum80_legacy_verify':'brewlite_scrum80_verify';
const compose=path.join(root,'compose.scrum80.test.yml');
const envfile=path.join(root,'.env.scrum80.local');
for(const p of [compose,envfile])if(!fs.existsSync(p))throw Error('Missing '+path.relative(root,p));
function docker(extra,input){
 const r=spawnSync('docker',['compose','--env-file',envfile,'-f',compose,...extra],
  {cwd:root,input,encoding:'utf8',windowsHide:true,maxBuffer:6*1024*1024});
 if(r.error||r.status!==0){if(r.stdout)process.stderr.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);
  throw Error(r.error?.message??`Docker command failed: ${r.status}`);}
 if(input!==undefined && r.stderr)process.stdout.write(r.stderr); // PostgreSQL NOTICE evidence
 return r.stdout.trim();
}
const port=docker(['port','postgres','5432']);
if(!/(127\.0\.0\.1|localhost):55480\b/.test(port))throw Error('STOP: wrong Docker port: '+port);
// Use tuple-only, unaligned output for safety probes; default psql output includes table headers.
const probe=(sql)=>docker(['exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],sql);
const psql=(sql)=>docker(['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],sql);
const actual=probe('SELECT current_database();').trim();
if(actual!==db)throw Error(`STOP: current_database differs: expected ${db}, got ${actual||'(empty)'}`);
const count=probe(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`).trim();
if(count!=='9')throw Error(`STOP: requires exactly nine applied migrations; found ${count||'(empty)'}`);
console.log(`[SCRUM80] Safety preflight PASS: isolated Docker PostgreSQL 127.0.0.1:55480 / ${db}; 9 migrations`);
for(const file of ['05_p2_06_index_catalog.sql','04_p2_06_unique_constraints.sql','06_p2_06_check_constraints.sql']){
 const p=path.join(root,'backend','prisma','tests',file);
 if(!fs.existsSync(p))throw Error('Missing '+path.relative(root,p));
 console.log(`[SCRUM80] Running ${file} on Docker database ${db}`);
 const out=psql(fs.readFileSync(p,'utf8'));
 console.log(out.slice(-1200));
}
console.log('[SCRUM80] SQL INDEX + UNIQUE + CHECK DML: completed without psql errors; fixtures rolled back.');
