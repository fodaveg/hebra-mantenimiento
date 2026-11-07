// Build of Mantenimiento as an EXTERNAL Hebra plugin (docs/SPEC-PLUGINS-EXTERNOS.md in the
// Hebra repo, sections 3 and 6). It produces, in the repo root,
//
//   hebra-main.mjs    ONE ES module (entry `src/main.ts`) that exports `activate`
//   hebra-styles.css  the plugin stylesheet (`src/hebra-styles.css`)
//   hebra.json        the manifest, GENERATED here (never by hand): version from
//                     package.json and the sha256 of the two files above
//
// and then runs the guard over `hebra-main.mjs`. Hebra loads the module from a `blob:` URL,
// where a relative or dynamic import has no base, and API 2.x runs it in a separate frame.
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findForbiddenCalls } from './forbidden-calls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/main.ts';
const STYLES_SOURCE = 'src/hebra-styles.css';
const MAIN_FILE = 'hebra-main.mjs';
const STYLES_FILE = 'hebra-styles.css';
const MANIFEST_FILE = 'hebra.json';

function sha256(file) {
  return `sha256:${createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')}`;
}

/**
 * Blanks comments and the CONTENT of string, template and regexp literals so the checks
 * below look at code only, and collects the literals. A small lexer, enough for esbuild
 * output: it tracks whether a `/` starts a regexp from the previous significant token.
 */
export function scanCode(text) {
  let code = '';
  const strings = [];
  let previous = '';
  let i = 0;
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$|(^|[^\w$.])(return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      code += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
        } else {
          value += text[j];
          j += 1;
        }
      }
      strings.push(value);
      code += ch + ch;
      previous = 'x"';
      i = j + 1;
      continue;
    }
    if (ch === '/' && regexAllowedAfter.test(previous)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j += 2;
        else {
          if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) break;
          j += 1;
        }
      }
      code += '/r/';
      previous = 'x/';
      i = j + 1;
      continue;
    }
    code += ch;
    if (!/\s/.test(ch)) previous = (previous + ch).slice(-12);
    i += 1;
  }
  return { code, strings };
}

/**
 * The guard. Returns the list of problems (empty = fine); the caller prints them and exits
 * non-zero. `metafile` is esbuild's, for the structural checks.
 */
export function guardBundle(text, metafile, mainFile = MAIN_FILE) {
  const problems = [];
  const { code, strings } = scanCode(text);
  const output = Object.values(metafile.outputs)[0];

  for (const imported of output.imports) {
    problems.push(`${mainFile}: import sin resolver «${imported.path}» (${imported.kind})`);
  }
  if (/(^|[^.\w$])import\s*\(/.test(code)) {
    problems.push(`${mainFile}: contiene un import() dinámico; una URL blob: no resuelve imports`);
  }
  const staticImport = /(^|[^.\w$])import\s*(["'`{*]|[\w$]+\s*(,|from\b))/.exec(code);
  if (staticImport) {
    problems.push(`${mainFile}: contiene un import estático («${staticImport[0].trim()}»)`);
  }
  if (/(^|[^.\w$])export\b[^;]*?\bfrom\s*["'`]/.test(code)) {
    problems.push(`${mainFile}: contiene un re-export desde otro módulo («export … from»)`);
  }
  for (const literal of strings) {
    if (/^\.{1,2}\//.test(literal) && /\.(m?[jt]s|json|css)$/.test(literal)) {
      problems.push(`${mainFile}: ruta relativa a un fichero entre comillas («${literal}»)`);
    }
    if (/^node:/.test(literal)) problems.push(`${mainFile}: referencia a «${literal}»`);
    if (literal === 'obsidian' || literal === 'electron') {
      problems.push(`${mainFile}: referencia a «${literal}»`);
    }
  }
  for (const name of ['process', 'Buffer', 'require', '__dirname', '__filename']) {
    const use = new RegExp(`(^|[^.\\w$])${name}\\b`).exec(code);
    if (use) problems.push(`${mainFile}: usa «${name}» (no existe en el navegador de Hebra)`);
  }
  for (const name of findForbiddenCalls(text)) {
    problems.push(`${mainFile}: contiene «${name}»: Mantenimiento no borra, mueve, renombra ni crea nada`);
  }
  if (!/export\s*\{[^}]*\bactivate\b[^}]*\}/.test(code)) {
    problems.push(`${mainFile}: no exporta «activate»`);
  }
  return problems;
}

export async function buildHebra() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: MAIN_FILE,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: '// Mantenimiento, plugin for Hebra. GENERATED by scripts/build-hebra.mjs: edit src/.'
    }
  });
  copyFileSync(join(ROOT, STYLES_SOURCE), join(ROOT, STYLES_FILE));

  const problems = guardBundle(readFileSync(join(ROOT, MAIN_FILE), 'utf8'), result.metafile);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`build:hebra GUARD: ${problem}`);
    throw new Error(`el guardarraíl de ${MAIN_FILE} falló (${problems.length})`);
  }

  const manifest = {
    schema: 1,
    id: 'hebra-mantenimiento',
    name: 'Mantenimiento',
    version: pkg.version,
    apiVersion: '^2.4.0',
    description:
      'Busca enlaces rotos, notas sin descripción, carpetas duplicadas y notas a las que nada enlaza, y propone arreglos con vista previa.',
    author: 'fodaveg',
    repo: 'fodaveg/hebra-mantenimiento',
    platforms: ['macos', 'ios', 'linux', 'windows', 'web'],
    main: MAIN_FILE,
    styles: STYLES_FILE,
    icon: 'wrench',
    capabilities: { required: ['vault.read', 'vault.write'], optional: [] },
    network: { hosts: [] },
    shared: {},
    files: { [MAIN_FILE]: sha256(MAIN_FILE), [STYLES_FILE]: sha256(STYLES_FILE) },
    ageRating: '4+'
  };
  writeFileSync(join(ROOT, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = await buildHebra();
    const size = readFileSync(join(ROOT, MAIN_FILE)).length;
    console.log(`build:hebra ok: ${MAIN_FILE} ${size} bytes, ${MANIFEST_FILE} v${manifest.version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
