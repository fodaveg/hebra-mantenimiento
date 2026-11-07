// Verifies a DRAFT release against a reference computed BEFORE anything was uploaded.
//
//   node scripts/verify-release.mjs <SHA256SUMS> <downloaded-dir> <assets.json> <tag> [draft|published]
//
// Two stages. `draft` (the default, what the workflow checks) expects exactly the three assets the
// workflow built. `published` (what `scripts/sign-publish.mjs` checks after publishing) expects
// those three plus `hebra.json.minisig`, the signature Hebra requires to install or update the
// plugin. The signature is made locally after the workflow, so it has no reference hash: it must
// be there and not empty, and `sign-publish.mjs` verifies it before uploading it.
//
// `SHA256SUMS` is `sha256sum` output over the three files the workflow built; `downloaded-dir`
// holds what was downloaded back from the draft; `assets.json` is the GitHub API asset list
// (with the digest GitHub computed itself). Comparing the downloaded files against the files
// they were downloaded from would prove nothing: the reference is the build output, taken
// before the upload. Hashes prove correspondence, not provenance; the workflow adds an
// attestation for that.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ASSETS = ['hebra-main.mjs', 'hebra-styles.css', 'hebra.json'];

/** Detached minisign signature of `hebra.json`, uploaded by `scripts/sign-publish.mjs`. */
export const SIGNATURE_ASSET = 'hebra.json.minisig';

export const PUBLISHED_ASSETS = [...RELEASE_ASSETS, SIGNATURE_ASSET].sort();

export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * @param {{ reference: Map<string,string>, assets: {name:string, digest?:string|null}[],
 *           files: Map<string, Buffer>, tag: string, stage?: 'draft'|'published' }} input
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function verifyRelease({ reference, assets, files, tag, stage = 'draft' }) {
  const problems = [];
  const warnings = [];
  const names = assets.map((a) => a.name).sort();
  const expectedNames = stage === 'published' ? PUBLISHED_ASSETS : [...RELEASE_ASSETS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    problems.push(`unexpected assets for a ${stage} release: ${names.join(', ')} (expected ${expectedNames.join(', ')})`);
  }
  if (stage === 'published') {
    const signature = assets.find((a) => a.name === SIGNATURE_ASSET);
    if (!signature) problems.push(`${SIGNATURE_ASSET}: missing, Hebra will not install this release`);
    else if (!(signature.size > 0)) problems.push(`${SIGNATURE_ASSET}: empty`);
  }
  for (const name of RELEASE_ASSETS) {
    const expected = reference.get(name);
    if (!expected) {
      problems.push(`${name}: not in the reference`);
      continue;
    }
    const file = files.get(name);
    if (!file) {
      problems.push(`${name}: not downloaded`);
      continue;
    }
    const got = sha256(file);
    if (got !== expected) problems.push(`${name}: downloaded sha256 ${got} != built ${expected}`);
    const digest = assets.find((a) => a.name === name)?.digest;
    if (!digest) warnings.push(`${name}: GitHub reported no digest to cross-check`);
    else if (digest !== `sha256:${expected}`) {
      problems.push(`${name}: GitHub digest ${digest} != built sha256:${expected}`);
    }
  }
  // The Hebra manifest must describe the files that were really published.
  const hebraJson = files.get('hebra.json');
  if (hebraJson) {
    const manifest = JSON.parse(hebraJson.toString('utf8'));
    const hebraFiles = ['hebra-main.mjs', 'hebra-styles.css'];
    if (manifest.version !== tag) problems.push(`hebra.json version ${manifest.version} != tag ${tag}`);
    if (JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(hebraFiles)) {
      problems.push(`hebra.json lists unexpected files: ${Object.keys(manifest.files ?? {}).join(', ')}`);
    }
    for (const name of hebraFiles) {
      const file = files.get(name);
      if (file && manifest.files?.[name] !== `sha256:${sha256(file)}`) {
        problems.push(`${name}: hebra.json declares ${manifest.files?.[name]} but the published file is sha256:${sha256(file)}`);
      }
    }
  }
  return { problems, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sumsPath, dir, assetsPath, tag, stage = 'draft'] = process.argv.slice(2);
  if (!sumsPath || !dir || !assetsPath || !tag || !['draft', 'published'].includes(stage)) {
    console.error('usage: verify-release.mjs <SHA256SUMS> <downloaded-dir> <assets.json> <tag> [draft|published]');
    process.exit(2);
  }
  const reference = parseSums(readFileSync(sumsPath, 'utf8'));
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const files = new Map();
  for (const name of RELEASE_ASSETS) {
    try {
      files.set(name, readFileSync(join(dir, name)));
    } catch {
      // reported by verifyRelease as «not downloaded»
    }
  }
  const { problems, warnings } = verifyRelease({ reference, assets, files, tag, stage });
  for (const warning of warnings) console.warn(`verify-release warning: ${warning}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-release FAIL: ${problem}`);
    process.exit(1);
  }
  console.log(`verify-release ok: ${RELEASE_ASSETS.join(' ')} match the reference built before upload${stage === 'published' ? ` and ${SIGNATURE_ASSET} is present` : ''}`);
}
