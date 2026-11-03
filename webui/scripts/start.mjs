#!/usr/bin/env node
// The `ms-webui` bin: environment gate, then the full vite server.
//
// The webui's backend (train/eval/deploy executors, model config, the OpenAI proxy) lives in
// the vite dev-server middleware — so "starting the webui" means starting vite itself from the
// package's own source. The gate first: check-swift exits non-zero with an actionable message
// when the driven python environment lacks ms-swift >= 5.0, and we stop before binding a port.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webuiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const gate = spawnSync(process.execPath, [join(webuiRoot, 'scripts', 'check-swift.mjs')], {
  stdio: 'inherit',
});
if (gate.status !== 0) {
  process.exit(gate.status ?? 1);
}

const { createServer } = await import('vite');
const server = await createServer({
  root: webuiRoot,
  /* --host: a packaged install is typically driven from another machine / container */
  server: { host: true },
});
await server.listen();
server.printUrls();
