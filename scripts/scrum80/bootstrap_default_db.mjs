/** Bootstrap only the isolated SCRUM-80 Compose default database.
 * Works in Git Bash and PowerShell: node scripts/scrum80/bootstrap_default_db.mjs
 * Rejects nonempty databases with unknown migrations; never resets or drops data.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const backend=path.join(root,'backend');
const compose=path.join(root,'compose.scrum80.test.yml');
const envFile=path.join(root,'.env.scrum80.local');
const db='brewlite_scrum80_verify';
if(process.argv.length!==2)throw Error('Usage: node scripts/scrum80/bootstrap_default_db.mjs');
for(const f of [compose,envFile,path.join(backend,'prisma7.config.ts')])if(!fs.existsSync(f))throw Error('Missing '+f);
function run(command,args,options={}){
 const r=spawnSync(command,args,{cwd:options.cwd??root,env:options.env??process.env,
   input:options.input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,
   shell:process.platform==='win32' && command==='npx.cmd'});
 if(r.error||r.status!==0){process.stderr.write(r.stdout??'');process.stderr.write(r.stderr??'');throw Error(`STOP: ${command} failed: ${r.error?.message??r.status}`);}
 return r.stdout.trim();
}
const docker=(args,input)=>run('docker',['compose','--env-file',envFile,'-f',compose,...args],{input});
const port=docker(['port','postgres','5432']);
if(!/(127\.0\.0\.1|localhost):55480\b/.test(port))throw Error('STOP: incorrect isolated Docker port '+port);
const query=(statement)=>docker(['exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],statement);
if(query('SELECT current_database();')!==db)throw Error('STOP: wrong database');
const seen=query("SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN '0' ELSE 'present' END;");
if(seen==='present'){
 const names=query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;').split(/\r?\n/);
 const expected=fs.readdirSync(path.join(backend,'prisma/migrations'),{withFileTypes:true})
   .filter(x=>x.isDirectory()&&fs.existsSync(path.join(backend,'prisma/migrations',x.name,'migration.sql')))
   .map(x=>x.name).sort();
 if(names.length!==expected.length||expected.length!==9||names.some((x,i)=>x!==expected[i]))throw Error('STOP: database migration history does not match exactly nine repository migrations');
} else if(seen!=='0')throw Error('STOP: unknown database history');
const match=fs.readFileSync(envFile,'utf8').match(/^SCRUM80_DB_PASSWORD=([^\r\n]+)$/m);
if(!match)throw Error('Missing SCRUM80_DB_PASSWORD');
const url=new URL(`postgresql://postgres@127.0.0.1:55480/${db}`);
url.password=match[1].trim().replace(/^["']|["']$/g,'');url.searchParams.set('schema','public');
const env={...process.env,DATABASE_URL:url.toString()};
const npx=process.platform==='win32'?'npx.cmd':'npx';
console.log('[SCRUM80] Safety preflight PASS: isolated Compose '+db+'; history '+(seen==='0'?'empty':'9 migrations'));
for(const args of [ ['prisma','migrate','deploy','--config','prisma7.config.ts'], ['prisma','migrate','status','--config','prisma7.config.ts'], ['prisma','migrate','deploy','--config','prisma7.config.ts'] ]){
 console.log('[SCRUM80] Running '+args.join(' '));
 console.log(run(npx,args,{cwd:backend,env}));
}
if(query('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')!=='9')throw Error('STOP: expected nine migrations');
console.log('[SCRUM80] PASS: clean Compose default DB migrated; migrate status and non-destructive redeploy verified');
