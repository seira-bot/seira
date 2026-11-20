// Side-effect import that scrubs ambient Seira env before a module snapshots it (scripts/mcp-server.ts reads
// SEIRA_URL / SEIRA_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientSeiraKey } from "./seira-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientSeiraKey(key)) delete process.env[key];
}
