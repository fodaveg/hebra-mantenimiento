// Gate before publishing (`npm run release:check`), run LOCALLY. CI cannot run it: the tests
// that check this plugin against Hebra's REAL `api.markdown` need a bundle of Hebra's source
// (`.real/frame-markdown.mjs`), and Hebra is a private repository without a licence while this
// plugin is public and MIT, so that bundle never goes into the repo. Without it those tests skip
// themselves, which is fine for development and NOT for a release. This script:
//
//   1. builds the bundle (`npm run build:real-markdown`, with HEBRA_SRC if the default
//      ~/code/hebra-cand-20261107 is not a Hebra checkout with plugin API 2.4) and fails if
//      `.real/frame-markdown.mjs` is still missing;
//   2. runs lint, typecheck and the Hebra build (with its guard);
//   3. runs every test and FAILS if any was skipped, which is how it knows the real-Hebra tests
//      really ran.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = join(ROOT, '.real', 'frame-markdown.mjs');
const fail = (message) => {
  console.error(`release:check FAIL: ${message}`);
  process.exit(1);
};
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} terminó con ${result.status}`);
};

run('npm', ['run', 'build:real-markdown']);
if (!existsSync(REAL)) fail(`falta ${REAL}: define HEBRA_SRC con un checkout de Hebra con la API 2.4`);
run('npm', ['run', 'lint']);
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'build:hebra']);

const report = join(tmpdir(), `mantenimiento-release-check-${process.pid}.json`);
const tests = spawnSync('npx', ['vitest', 'run', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
if (!existsSync(report)) fail('vitest no escribió su informe');
const json = JSON.parse(readFileSync(report, 'utf8'));
const { numPassedTests: passed, numFailedTests: failed, numPendingTests: skipped, numTodoTests: todo, numTotalTests: total } = json;
console.log(`release:check tests: ${total} en total, ${passed} pasan, ${failed} fallan, ${skipped} saltados, ${todo} pendientes`);
if (tests.status !== 0 || failed > 0) fail('hay tests rojos');
if (skipped > 0 || todo > 0) fail(`${skipped + todo} tests saltados: los de Hebra real no se ejecutaron`);
console.log('release:check ok: lint, tipos, build de Hebra y todos los tests, ninguno saltado');
