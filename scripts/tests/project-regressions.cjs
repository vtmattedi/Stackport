const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = '/app/dist';
const database = require(`${root}/config/database`);
database.initializeDatabase();

async function main() {
  const project = require(`${root}/services/projectAdmin`).createProject({name: 'Regression', sourceType: 'upload'});
  assert.equal(project.internalPort, null);
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
}
main().catch(error => {console.error(error); process.exitCode = 1;});
