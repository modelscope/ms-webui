#!/usr/bin/env node
// Pre-start gate: the python environment this webui drives must have ms-swift >= 5.0.
//
// The webui's task executors spawn `python -m swift.dev.cli.*` (training / deploy / eval), so
// an environment without ms-swift produces nothing but per-task failures — fail here instead,
// with the fix in the message. Dev releases (version containing ".dev", e.g. an editable
// checkout at 4.5.0.dev0) are let through: that is the local-development escape hatch.
//
// Exit codes: 0 = ok; 1 = ms-swift too old; 2 = ms-swift not installed; 3 = python missing.
import { spawnSync } from 'node:child_process';

const PY_SNIPPET = [
  'import importlib.metadata as m, sys',
  'try:',
  '    v = m.version("ms-swift")',
  'except m.PackageNotFoundError:',
  '    sys.exit(2)',
  'major = v.split(".")[0]',
  'ok = (major.isdigit() and int(major) >= 5) or ".dev" in v',
  'print(v)',
  'sys.exit(0 if ok else 1)',
].join('\n');

function fail(code, message) {
  console.error(`[ms-webui] ${message}`);
  process.exit(code);
}

const python = process.env.SWIFT_PYTHON || 'python';
const probe = spawnSync(python, ['-c', PY_SNIPPET], { encoding: 'utf8' });
if (probe.error) {
  fail(3, `python interpreter not found (${python}). Set SWIFT_PYTHON to the one with ms-swift installed.`);
}
const version = (probe.stdout || '').trim();
switch (probe.status) {
  case 0:
    console.log(`[ms-webui] ms-swift ${version} detected`);
    process.exit(0);
  case 2:
    fail(2, `ms-swift is not installed in the "${python}" environment. Install it first:\n  pip install -U ms-swift`);
  case 1:
    fail(1, `ms-swift ${version} is too old (5.0+ required). Upgrade it:\n  pip install -U 'ms-swift>=5.0'`);
  default:
    fail(3, `probe of the "${python}" environment failed:\n${probe.stderr || probe.stdout || '(no output)'}`);
}
