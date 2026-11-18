// Run from the repository root with --import tsx --import ./tests/setup.ts.
// Uses disposable Docker resources only; no host ports or real installation.
if (process.env.NODE_ENV !== 'test' || !process.env.SQLITE_PATH) throw new Error('Load tests/setup.ts before this smoke test.');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { initializeDatabase, closeDatabase } = require('../../src/config/database.ts');
const { config } = require('../../src/config/env.ts');
const { expectedComposeProjectName } = require('../../src/modules/projects/workspace.ts');
const { exportProject, importProject } = require('../../src/modules/backup/projectArchive.ts');
const { DockerVolumeEngine } = require('../../src/modules/backup/volumeEngine.ts');
const suffix = randomUUID().slice(0, 8);
const created = [];
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`${args.slice(0, 2).join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
(async () => {
  try {
    const db = initializeDatabase();
    const name = `backup-smoke-${suffix}`;
    const id = Number(db.prepare("INSERT INTO projects (name, source_type) VALUES (?, 'github')").run(name).lastInsertRowid);
    const compose = expectedComposeProjectName({ id, name });
    const sourceVolume = `${compose}_payload`;
    created.push(sourceVolume);
    docker(['volume', 'create', '--label', `com.docker.compose.project=${compose}`, '--label', 'com.docker.compose.volume=payload', sourceVolume]);
    docker(['run', '--rm', '--pull=never', '--mount', `type=volume,src=${sourceVolume},dst=/v`, '--entrypoint', 'sh', 'stackport:ci', '-c', "mkdir -p /v/db; printf 'backup-restore-payload' > /v/db/record; chown -R 999:999 /v/db; chmod 700 /v/db; chmod 600 /v/db/record"]);
    const engine = new DockerVolumeEngine('stackport:ci');
    const file = path.join(path.dirname(config.sqlitePath), 'project.spbackup');
    const passphrase = 'local fixture passphrase';
    console.log('Exporting a real Docker volume with restricted ownership');
    const archive = await exportProject({ projectId: id, outPath: file, passphrase, engine, db });
    const restoredName = `restored-${name}`;
    const result = await importProject({ archivePath: file, passphrase, name: restoredName, engine, requireVerified: true, db });
    const targetCompose = expectedComposeProjectName({ id: result.projectId, name: restoredName });
    const targets = await engine.namedVolumes(targetCompose);
    assert.equal(targets.length, 1);
    const target = targets[0].name;
    created.push(target);
    assert.notEqual(target, sourceVolume);
    assert.equal(result.digest, archive.digest);
    assert.equal(await engine.treeDigest({ kind: 'named', name: sourceVolume }), await engine.treeDigest({ kind: 'named', name: target }));
    const data = docker(['run', '--rm', '--pull=never', '--mount', `type=volume,src=${target},dst=/v,readonly`, '--entrypoint', 'sh', 'stackport:ci', '-c', "cat /v/db/record; printf '\\n'; stat -c '%u:%g %a' /v/db/record"]);
    assert.equal(data, 'backup-restore-payload\n999:999 600');
    console.log(JSON.stringify({ realDockerVolume: true, verifiedDigest: true, restoredContent: true, owner: '999:999', mode: '600' }));
  } finally {
    for (const volume of created) spawnSync('docker', ['volume', 'rm', volume], { encoding: 'utf8', timeout: 15000 });
    closeDatabase();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
