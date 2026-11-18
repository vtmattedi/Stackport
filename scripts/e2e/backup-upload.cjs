// Run from the repository root with --import tsx --import ./tests/setup.ts.
// Uses disposable Docker resources only; no host ports or real installation.
if (process.env.NODE_ENV !== 'test' || !process.env.SQLITE_PATH) throw new Error('Load tests/setup.ts before this smoke test.');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { initializeDatabase, closeDatabase } = require('../../src/config/database.ts');
const { config } = require('../../src/config/env.ts');
const { generateNginxConfig, setNginxAppConfig } = require('../../src/modules/ingress/nginx/configWriter.ts');
const { FULL_BACKUP_MAX_UPLOAD_BYTES } = require('../../src/shared/backupLimits.ts');
const suffix = randomUUID().slice(0, 8);
const network = `sp-backup-proxy-${suffix}`;
const backend = `${network}-backend`;
const proxy = `${network}-nginx`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`${args.slice(0, 2).join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
(async () => {
  try {
    initializeDatabase();
    setNginxAppConfig({ enabled: true, domain: 'sp.example.test', useSsl: false });
    const generated = await generateNginxConfig([]);
    const conf = path.join(path.dirname(config.sqlitePath), 'proxy-smoke.conf');
    fs.writeFileSync(conf, generated);
    docker(['network', 'create', network]);
    const server = `require('node:http').createServer((req,res)=>{let bytes=0;req.on('data',chunk=>bytes+=chunk.length);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({bytes,path:req.url}));});}).listen(${config.port},'0.0.0.0')`;
    docker(['run', '--detach', '--pull=never', '--name', backend, '--network', network, '--network-alias', 'stackport', '--entrypoint', 'node', 'stackport:ci', '-e', server]);
    console.log('Starting nginx with the generated config');
    docker(['create', '--pull=never', '--name', proxy, '--network', network, '--entrypoint', 'nginx', 'nginx:1.29-alpine', '-g', 'daemon off;']);
    docker(['cp', conf, `${proxy}:/etc/nginx/conf.d/default.conf`]);
    docker(['start', proxy]);
    docker(['exec', proxy, 'nginx', '-t']);
    const client = `
      (async()=>{
        const headers={Host:'sp.example.test','Content-Type':'application/octet-stream'};
        const request=(route,body,length=body.length)=>new Promise((resolve,reject)=>{const req=require('node:http').request({hostname:'${proxy}',port:80,path:route,method:'PUT',headers:{...headers,'Content-Length':length}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});
        for(let i=0;i<30;i++){try{const r=await request('/health',Buffer.alloc(0));if(r.status===200)break;}catch{} await new Promise(r=>setTimeout(r,100));}
        const uploaded=await request('/api/backup/restore/upload',Buffer.alloc(2*1024*1024,65));
        const uploadBody=JSON.parse(uploaded.body);
        const normal=await request('/api/other',Buffer.alloc(2*1024*1024));
        const tooLarge=await request('/api/backup/restore/upload',Buffer.alloc(0),${FULL_BACKUP_MAX_UPLOAD_BYTES}+1);
        console.log(JSON.stringify({uploadStatus:uploaded.status,receivedBytes:uploadBody.bytes,normalRouteStatus:normal.status,overLimitStatus:tooLarge.status}));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const result = JSON.parse(docker(['exec', backend, 'node', '-e', client]));
    assert.deepEqual(result, { uploadStatus: 200, receivedBytes: 2097152, normalRouteStatus: 413, overLimitStatus: 413 });
    console.log(JSON.stringify({ nginx: '1.29-alpine', syntaxChecked: true, ...result }));
  } finally {
    spawnSync('docker', ['rm', '-f', proxy, backend], { encoding: 'utf8', timeout: 15000 });
    spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8', timeout: 15000 });
    closeDatabase();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
