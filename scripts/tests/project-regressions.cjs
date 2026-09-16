const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = '/app/dist';
const database = require(`${root}/config/database`);
database.initializeDatabase();

async function main() {
  const project = require(`${root}/services/projectAdmin`).createProject({name: 'Regression', sourceType: 'upload'});
  assert.equal(project.internalPort, null);
  // Simulate upgrading a database whose existing projects predate groups.
  database.getDatabase().exec('ALTER TABLE projects DROP COLUMN group_name');
  database.closeDatabase();
  database.initializeDatabase();
  const restored = require(`${root}/services/projectDeploy`).getProjectById(project.id);
  assert.equal(restored.name, 'Regression');
  assert.equal(restored.groupName, null);
  database.getDatabase().prepare('UPDATE projects SET compose_file=? WHERE id=?').run('compose.yml', project.id);
  const domains = require(`${root}/services/projectDomains`);
  domains.addProjectDomain(project.id, 'site.install.test', false, 'web', 80);
  domains.addProjectDomain(project.id, 'www.site.install.test', false, 'web', 80);
  await require(`${root}/services/projectDeploy`).ensureProjectProxyNetwork(project.id);
  const nginx = require(`${root}/services/nginx/configWriter`);
  let applied = await nginx.writeNginxConfig();
  assert(applied.ok, applied.output);
  const generated = await fs.readFile('/etc/nginx/sites-available/default', 'utf8');
  assert.equal((generated.match(/server_name www.site.install.test;/g) || []).length, 1);

  // Exercise the real HTTP endpoint, including the legacy-port regression.
  const token = require(`${root}/services/authTokens`).issueAuthToken('regression');
  const headers = {Authorization: `Bearer ${token}`};
  const jsonHeaders = {...headers, 'Content-Type': 'application/json'};
  let response = await fetch('http://localhost:3000/api/projects', {method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({name: 'Grouped project', sourceType: 'upload', groupName: ' Mw Control '})});
  const grouped = await response.json();
  assert.equal(response.status, 201, JSON.stringify(grouped));
  assert.equal(grouped.groupName, 'Mw Control');
  for (const groupName of ['Mw Control', null]) {
    response = await fetch(`http://localhost:3000/api/projects/${project.id}`, {method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({groupName})});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).groupName, groupName);
  }
  response = await fetch(`http://localhost:3000/api/projects/${project.id}`, {method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({groupName: 'x'.repeat(101)})});
  assert.equal(response.status, 400);
  response = await fetch(`http://localhost:3000/api/projects/${project.id}/ingress-targets`, {headers});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{service: 'web', containerPort: 80}]);
  response = await fetch(`http://localhost:3000/api/projects/${project.id}/domains`, {method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({domain: 'invalid.install.test', service: 'web', containerPort: 9000})});
  assert.equal(response.status, 400);
  console.log('PASS: group migration/create/update/clear; detected ingress API; undeclared ports rejected');
  // Old runtime settings must not restore removed host behavior.
  database.getDatabase().prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('nginx_runtime','host')").run();
  assert.equal(nginx.getNginxRuntime(), 'container');
  response = await fetch('http://localhost:3000/api/system/nginx/runtime', {method:'PUT', headers:jsonHeaders, body:JSON.stringify({runtime:'host'})});
  assert.equal(response.status, 404);
  response = await fetch('http://localhost:3000/api/system/install/nginx', {method:'POST', headers});
  assert.equal(response.status, 404);
  const visit = async () => {
    const status = await new Promise((resolve, reject) => {
      const request = require('node:http').get({hostname:'stackport-nginx', path:'/traffic-regression',
        headers:{Host:'site.install.test', 'User-Agent':'traffic-regression'}}, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    assert.equal(status, 200);
  };
  await visit();
  response = await fetch('http://localhost:3000/api/metrics/nginx?period=24h', {headers});
  const traffic = await response.json();
  assert(traffic.available, JSON.stringify(traffic));
  assert.equal(traffic.logPath, 'docker:stackport-nginx');
  assert(traffic.domains.some(row => row.host === 'site.install.test' && row.requests > 0));
  response = await fetch('http://localhost:3000/api/metrics/nginx/requests?host=site.install.test', {headers});
  const requests = await response.json();
  assert(requests.entries.some(row => row.path === '/traffic-regression' && row.requestTimeMs !== null));
  response = await fetch('http://localhost:3000/api/metrics/nginx/clear', {method:'POST', headers});
  assert.equal(response.status, 200);
  response = await fetch('http://localhost:3000/api/metrics/nginx/requests?host=site.install.test', {headers});
  assert.equal((await response.json()).entries.length, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  await visit();
  response = await fetch('http://localhost:3000/api/metrics/nginx/requests?host=site.install.test', {headers});
  assert.equal((await response.json()).entries.length, 1);
  console.log('PASS: Docker traffic domain totals, request timing, clear cutoff; removed host APIs');
  for (const domain of domains.listProjectDomains(project.id)) {
    const response = await fetch(`http://localhost:3000/api/projects/${project.id}/domains/${domain.id}/ssl/issue`, {method: 'POST', headers});
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert(body.started);
    let action;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await fetch(`http://localhost:3000/api/projects/${project.id}/actions`, {headers});
      const snapshot = await status.json();
      action = snapshot.ssl.find(row => row.id === body.action.id);
      if (action && action.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(action?.status, 'success', action?.log);
  }
  console.log('PASS: post-deploy ingress attachment, explicit www, SSL API without a host port');

  // Network augmentation must keep private networks and service aliases intact.
  const networking = require(`${root}/services/composeNetworking`);
  const yaml = require(`${root}/services/composeYaml`);
  const dir = '/app/data/network-regression';
  await fs.mkdir(dir, {recursive: true});
  for (const networks of [['private'], {private: {aliases: ['db-client']}}]) {
    const file = path.join(dir, 'compose.yml');
    await fs.writeFile(file, yaml.dumpYamlDoc({services: {web: {image: 'nginx', networks}}, networks: {private: {}}}));
    const result = await networking.applyStackportProxyNetwork(dir, 'compose.yml', ['web']);
    assert(result.ok);
    const output = yaml.loadYamlDoc(await fs.readFile(file, 'utf8'));
    if (Array.isArray(networks)) assert.deepEqual(output.services.web.networks, ['private', 'stackport-proxy']);
    else assert.deepEqual(output.services.web.networks.private, networks.private);
  }
  console.log('PASS: proxy augmentation preserves custom networks and aliases');
  const extract = require(`${root}/services/composeIngress`).extractComposeIngressTargets;
  assert.deepEqual(extract({services: {
    web: {expose: [3000, '3000/tcp', '3001-3002/tcp', '53/udp'], ports: [{target: 443, published: '8192'}, {target: 53, protocol: 'udp'}]},
    api: {environment: {PORT: '4000'}}, db: {environment: {PASSWORD: 'private'}}, invalid: {expose: ['${PORT}', 0, 65536]},
  }}), [{service: 'api', containerPort: 4000}, ...[443, 3000, 3001, 3002].map(containerPort => ({service: 'web', containerPort}))]);
  console.log('PASS: port ranges, TCP/UDP, duplicates, environment ports and private values');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
