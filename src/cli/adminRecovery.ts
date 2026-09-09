/* eslint-disable no-console -- this file's entire purpose is printing to the operator's terminal */
// Invoked by `stackport admin-recovery` via `docker exec -i stackport node dist/cli/adminRecovery.js`
// (see stackport.sh) — never over HTTP. `docker exec` on the docker.sock already *is*
// the "local root" authorization boundary stackport_host_lifecycle.md §6.1 requires,
// so no separate unauthenticated endpoint exists to trigger this (invariant #4/§6.1).
import { initializeDatabase } from "../config/database";
import { createRecoveryCredential, RECOVERY_CREDENTIAL_TTL_MS } from "../services/installation";
import { getNginxAppConfig } from "../services/nginx/configWriter";

function main(): void {
  initializeDatabase();
  const { username, password } = createRecoveryCredential();
  const appConfig = getNginxAppConfig();
  const url = appConfig.domain ? `https://${appConfig.domain}` : "https://<server-ip>";
  const minutes = Math.round(RECOVERY_CREDENTIAL_TTL_MS / 60_000);

  console.log("");
  console.log("StackPort administrator recovery enabled.");
  console.log("");
  console.log(`URL:      ${url}`);
  console.log(`Username: ${username}`);
  console.log(`Password: ${password}`);
  console.log("");
  console.log("This credential is temporary and only permits");
  console.log("administrator recovery.");
  console.log("");
  console.log(`Expires in ${minutes} minutes.`);
  console.log("");
}

main();
