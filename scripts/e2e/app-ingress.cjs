// Startup integration check using disposable Docker resources; run through npm run test:ingress:docker.
const {spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const workDir=fs.mkdtempSync(path.join(os.tmpdir(),'stackport-app-ingress-'));
const prefix='sp-own-tls-'+randomUUID().slice(0,8);
const backend=prefix+'-backend',nginx=prefix+'-nginx';
const volumes=[prefix+'-nginx',prefix+'-certs',prefix+'-acme'];
function docker(args){const r=spawnSync('docker',args,{encoding:'utf8',timeout:90000});if(r.status!==0)throw new Error(args.slice(0,2).join(' ')+': '+(r.stderr||r.error));return r.stdout.trim();}
(async()=>{
try{
  docker(['network','create',prefix]);
  for(const volume of volumes)docker(['volume','create',volume]);
  const mounts=['--mount',`type=volume,src=${volumes[0]},dst=/fixture/nginx`,'--mount',`type=volume,src=${volumes[1]},dst=/etc/letsencrypt`,'--mount',`type=volume,src=${volumes[2]},dst=/var/lib/stackport/certbot-webroot`];
  docker(['create','--pull=never','--name',backend,'--network',prefix,'--network-alias','stackport','--network-alias','sp1-web',...mounts,'--mount','type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock','-e','NODE_ENV=test','-e','JWT_SECRET=local-ingress-fixture','-e','WEBHOOK_SECRET=local-ingress-fixture-hook','-e','SQLITE_PATH=/fixture/data/stackport.sqlite','-e','DEPLOY_ROOT=/fixture/data/repos','-e','NGINX_PATH=/fixture/nginx','-e','STACKPORT_DOMAIN=installer.example.test','-e',`FIXTURE_NGINX=${nginx}`,'--entrypoint','sleep','stackport:ci','infinity']);
  docker(['start',backend]);
  docker(['cp',path.resolve('dist')+'/.',backend+':/app/dist']);
  for (const dependency of ['tldts', 'tldts-core']) {
    docker(['cp',path.resolve('node_modules',dependency)+'/.',backend+':/app/node_modules/'+dependency]);
  }
  docker(['cp',path.join(__dirname,'fixtures','app-ingress.cjs'),backend+':/tmp/fixture.cjs']);
  docker(['exec',backend,'mkdir','-p','/tmp/bin']);
  const shim=path.join(workDir,'docker');
  fs.writeFileSync(shim,`#!/bin/bash\nargs=()\nfor arg in "$@"; do if [[ "$arg" == "stackport-nginx" ]]; then args+=("${nginx}"); else args+=("$arg"); fi; done\nexec /usr/bin/docker "\${args[@]}"\n`);
  docker(['cp',shim,backend+':/tmp/bin/docker']);
  docker(['exec',backend,'chmod','755','/tmp/bin/docker']);
  const fixturePath='/tmp/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  docker(['exec','-e','PATH='+fixturePath,backend,'node','/tmp/fixture.cjs','prepare']);
  docker(['create','--pull=never','--name',nginx,'--network',prefix,...mounts,'--entrypoint','nginx','nginx:1.30.7-alpine','-g','daemon off;']);
  docker(['cp',backend+':/fixture/nginx/nginx.conf',path.join(workDir,'nginx.conf')]);
  docker(['cp',path.join(workDir,'nginx.conf'),nginx+':/etc/nginx/nginx.conf']);
  docker(['start',nginx]);
  console.log(docker(['exec','-e','PATH='+fixturePath,backend,'node','/tmp/fixture.cjs','test']));
}finally{
  spawnSync('docker',['rm','-f',nginx,backend],{encoding:'utf8',timeout:15000});
  spawnSync('docker',['network','rm',prefix],{encoding:'utf8',timeout:15000});
  for(const volume of volumes)spawnSync('docker',['volume','rm',volume],{encoding:'utf8',timeout:15000});
  if(path.dirname(path.resolve(workDir))===path.resolve(os.tmpdir())&&path.basename(workDir).startsWith('stackport-app-ingress-'))fs.rmSync(workDir,{recursive:true,force:true});
}
})().catch(error=>{console.error(error);process.exitCode=1;});
