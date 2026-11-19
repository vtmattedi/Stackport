// Startup integration check using disposable Docker resources; run through npm run test:ingress:docker.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const database = require('/app/dist/config/database');
const { config } = require('/app/dist/config/env');
const { getNginxAppConfig, setNginxAppConfig } = require('/app/dist/modules/ingress/nginx/appConfig');
const { generateNginxConfig } = require('/app/dist/modules/ingress/nginx/configWriter');
const { invalidateCertCaches } = require('/app/dist/modules/ingress/certificates/operations');
const { ensureAppIngress, appIngressDeps } = require('/app/dist/modules/ingress/bootstrap');
const hostname = 'sp.example.test';
const nginx = process.env.FIXTURE_NGINX;
function request(secure, requestPath) {
  return new Promise((resolve, reject) => {
    const client = secure ? https : http;
    const req = client.get({ host: nginx, port: secure ? 443 : 80, path: requestPath, headers: { Host: hostname }, servername: hostname, rejectUnauthorized: false }, res => {
      const chunks=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject); req.setTimeout(5000,()=>req.destroy(new Error('HTTP fixture timed out')));
  });
}
(async () => {
  database.initializeDatabase();
  if (process.argv[2] === 'prepare') {
    setNginxAppConfig({enabled:true,domain:hostname,useSsl:true});
    const content = await generateNginxConfig([]);
    fs.mkdirSync('/fixture/nginx/sites-available',{recursive:true});
    fs.writeFileSync('/fixture/nginx/sites-available/default',content);
    fs.writeFileSync('/fixture/nginx/nginx.conf','events {}\nhttp { include /fixture/nginx/sites-available/default; }\n');
    database.closeDatabase();
    return;
  }
  const server = http.createServer((_req,res)=>res.end('stackport fixture'));
  await new Promise(resolve=>server.listen(config.port,'0.0.0.0',resolve));
  let applies=0, issues=0;
  const apply=appIngressDeps.apply;
  appIngressDeps.apply=async()=>{applies++;return apply();};
  // Substitute the external CA only. Readiness, certificate detection, config
  // generation, validation, reload and HTTP/HTTPS all use the production code.
  appIngressDeps.issue=async domain=>{
    issues++;
    assert.equal(domain,hostname);
    fs.mkdirSync('/var/lib/stackport/certbot-webroot/.well-known/acme-challenge',{recursive:true});
    fs.writeFileSync('/var/lib/stackport/certbot-webroot/.well-known/acme-challenge/probe','challenge-ok');
    assert.deepEqual(await request(false,'/.well-known/acme-challenge/probe'),{status:200,body:'challenge-ok'});
    const certDir='/etc/letsencrypt/live/'+hostname;
    fs.mkdirSync(certDir,{recursive:true});
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname,'-keyout',path.join(certDir,'privkey.pem'),'-out',path.join(certDir,'fullchain.pem')],{stdio:'ignore'});
    invalidateCertCaches();
    return {ok:true,output:'local test certificate issued'};
  };
  try {
    await ensureAppIngress();
    assert.equal(issues,1);
    assert.equal(applies,2);
    let secure;
    for(let i=0;i<30;i++){try{secure=await request(true,'/health');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
    assert.deepEqual(secure,{status:200,body:'stackport fixture'});
    await ensureAppIngress();
    assert.equal(issues,1,'a later boot must reuse the existing certificate');
    assert.equal(applies,3);
    assert.equal(getNginxAppConfig().domain,hostname,'the saved domain wins over STACKPORT_DOMAIN');
    console.log(JSON.stringify({startupRepair:true,acmeHttpChallenge:true,httpsReachable:true,reusesExistingCertificate:true,savedHostnamePreserved:true}));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    database.closeDatabase();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
