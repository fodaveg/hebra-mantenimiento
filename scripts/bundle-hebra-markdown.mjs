// Bundles Hebra's REAL `api.markdown` (frame-markdown.ts: frontmatter, setProperty, links…) into
// `.real/frame-markdown.mjs` (git-ignored) so tests can check this plugin against how Hebra
// really parses, which the fake host of hebra-plugin-api does not imitate (its `frontmatter`
// returns null, `setProperty` is not implemented, `links` is an approximation).
//
//   HEBRA_SRC=<a Hebra checkout with plugin API 2.4> npm run build:real-markdown
//
// Default: ~/code/hebra-cand-20261107. Needs that checkout's node_modules. Not part of the
// plugin build; `tests/real-markdown.test.ts` skips itself when the bundle is absent.
import esbuild from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.HEBRA_SRC ?? join(homedir(), 'code', 'hebra-cand-20261107');
const entry = join(SRC, 'src/lib/plugins/frame/frame-markdown.ts');
if (!existsSync(entry)) {
  console.error(`no existe ${entry}: define HEBRA_SRC con un checkout de Hebra con la API 2.4`);
  process.exit(1);
}
mkdirSync(join(ROOT, '.real'), { recursive: true });
const shim = join(ROOT, '.real', 'entry.ts');
writeFileSync(shim, `export { FRAME_MARKDOWN } from ${JSON.stringify(entry)};\n`);
await esbuild.build({
  entryPoints: [shim],
  outfile: join(ROOT, '.real', 'frame-markdown.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'error',
  absWorkingDir: SRC,
  nodePaths: [join(SRC, 'node_modules')]
});
console.log(`real markdown bundled from ${SRC}`);
