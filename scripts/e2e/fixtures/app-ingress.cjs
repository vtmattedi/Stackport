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
const { generateNginxConfig, writeNginxConfig } = require('/app/dist/modules/ingress/nginx/configWriter');
const { createProject } = require('/app/dist/modules/projects/operations');
const { addProjectDomain } = require('/app/dist/modules/ingress/domains');
const { invalidateCertCaches } = require('/app/dist/modules/ingress/certificates/operations');
const { ensureAppIngress, appIngressDeps } = require('/app/dist/modules/ingress/bootstrap');
const hostname = 'sp.example.test';
const nginx = process.env.FIXTURE_NGINX;
function request(secure, requestPath, domain = hostname) {
  return new Promise((resolve, reject) => {
    const client = secure ? https : http;
    const req = client.get({ host: nginx, port: secure ? 443 : 80, path: requestPath, headers: { Host: domain }, servername: domain, rejectUnauthorized: false }, res => {
      const chunks=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(), ...(res.headers.location ? { location: res.headers.location } : {})}));
    });
    req.on('error', reject); req.setTimeout(5000,()=>req.destroy(new Error('HTTP fixture timed out')));
  });
}
async function waitForResponse(secure, requestPath, domain, expectedStatus) {
  for (let i = 0; i < 30; i++) {
    const response = await request(secure, requestPath, domain).catch(() => null);
    if (response?.status === expectedStatus) return response;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${domain} did not return ${expectedStatus} for ${requestPath}`);
}

function createTestCertificate(domain, certificateName = domain) {
  const certDir = '/etc/letsencrypt/live/' + domain;
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + certificateName, '-addext', 'subjectAltName=DNS:' + certificateName, '-keyout', path.join(certDir, 'privkey.pem'), '-out', path.join(certDir, 'fullchain.pem')], { stdio: 'ignore' });
  invalidateCertCaches();
}

async function verifyAdminCutover() {
  const express = require('/app/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/system', require('/app/dist/application/http/system').default);
  const { actionRegistry, nginxKey } = require('/app/dist/modules/actions/registry');
  const { issueAuthToken } = require('/app/dist/modules/identity/sessions');
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const target = 'new-admin.example.test';
  const auth = issueAuthToken('admin');
  delete process.env.CERTBOT_EMAIL;
  const change = async () => {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/system/nginx/app`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, domain: target }),
    });
    assert.equal(response.status, 200);
    const { action } = await response.json();
    for (let i = 0; i < 60; i++) {
      const current = actionRegistry.get(nginxKey());
      if (current?.id === action.id && current.status !== 'running') return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Admin hostname action did not finish');
  };
  try {
    createTestCertificate(target, 'wrong.example.test');
    const failed = await change();
    assert.equal(failed.ok, false);
    assert.match(failed.log, /CERTBOT_EMAIL is required/);
    assert.equal(getNginxAppConfig().domain, hostname);
    await waitForResponse(true, '/health', hostname, 200);

    createTestCertificate(target);
    assert.equal((await change()).ok, true);
    assert.equal(getNginxAppConfig().domain, target);
    await waitForResponse(true, '/health', target, 200);
    assert.equal((await waitForResponse(false, '/health', target, 301)).location, `https://${target}/health`);
  } finally {
    await new Promise(resolve => api.close(resolve));
  }
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
    assert.deepEqual(await request(false,'/.well-known/acme-challenge/probe','new-admin.example.test'),{status:200,body:'challenge-ok'});
    assert.equal((await request(false,'/health')).status,503,'HTTPS hostname serves only the challenge before a certificate exists');
    createTestCertificate(domain);
    return {ok:true,output:'local test certificate issued'};
  };
  try {
    await ensureAppIngress();
    assert.equal(issues,1);
    assert.equal(applies,2);
    const secure = await waitForResponse(true, '/health', hostname, 200);
    assert.deepEqual(secure,{status:200,body:'stackport fixture'});
    assert.equal((await waitForResponse(false, '/health?test=1', hostname, 301)).location, `https://${hostname}/health?test=1`);
    await ensureAppIngress();
    assert.equal(issues,1,'a later boot must reuse the existing certificate');
    assert.equal(applies,3);
    assert.equal(getNginxAppConfig().domain,hostname,'the saved domain wins over STACKPORT_DOMAIN');
    const project = createProject({ name: 'TLS fixture', sourceType: 'upload' });
    addProjectDomain(project.id,'secure.example.test',true,'web',config.port);
    addProjectDomain(project.id,'plain.example.test',false,'web',config.port);
    assert.equal((await writeNginxConfig()).ok,true);
    await waitForResponse(false, '/health', 'secure.example.test', 503);
    assert.deepEqual(await request(false,'/.well-known/acme-challenge/probe','secure.example.test'),{status:200,body:'challenge-ok'});
    assert.deepEqual(await request(false,'/health','plain.example.test'),{status:200,body:'stackport fixture'});
    createTestCertificate('secure.example.test');
    assert.equal((await writeNginxConfig()).ok, true);
    assert.deepEqual(await waitForResponse(true, '/health', 'secure.example.test', 200), { status: 200, body: 'stackport fixture' });
    assert.equal((await waitForResponse(false, '/health', 'secure.example.test', 301)).location, 'https://secure.example.test/health');
    await verifyAdminCutover();
    console.log(JSON.stringify({startupRepair:true,acmeHttpChallenge:true,newHostnameChallenge:true,httpsRedirect:true,httpsReachable:true,reusesExistingCertificate:true,secureProjectWaitsForCert:true,explicitHttpProjectWorks:true,adminCutoverKeepsOldAddressOnFailure:true}));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    database.closeDatabase();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
