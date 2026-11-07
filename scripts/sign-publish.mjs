// Signs and publishes the verified DRAFT that `.github/workflows/release.yml` leaves for a tag.
//
//   npm run release:sign-publish -- <tag> [--dry-run] [--repo <owner/repo>]
//
// Why this runs on the maintainer's machine: Hebra only installs or updates a plugin whose
// release carries `hebra.json.minisig`, a minisign signature of the exact bytes of `hebra.json`
// made with the author's private key (`~/.config/hebra-plugin-signing/hebra-mantenimiento.key`). That
// key must never reach GitHub, so CI cannot sign. And releases are immutable once published
// (no asset can be added or replaced), so the signature has to be in the draft BEFORE it is
// published. Steps, each one stopping the script when it fails:
//
//   1. wait for the workflow run of the tag to finish, and require that it succeeded on the
//      tag's own commit;
//   2. find the draft, download its three assets, require each to carry the build-provenance
//      attestation of this repository's release workflow (that attestation is the workflow's
//      own hash of the build output) and match GitHub's digest, and run `verify-release.mjs`'s
//      checks (exactly three assets, hebra.json describing the Hebra files);
//   3. sign `hebra.json` and upload `hebra.json.minisig` to the draft with Hebra's
//      `scripts/firmar-release-plugin.mjs`, which verifies the signature before uploading it
//      (its repository is `$HEBRA_REPO`, default `~/code/hebra`);
//   4. publish the draft;
//   5. require the published release to be immutable and to have four assets: the three plus the
//      signature, all matching the hashes of step 2.
//
// `--dry-run` stops after signing without uploading anything and without publishing: it proves
// the key, the draft and the signer work together. The private key is never read or printed
// here: only the signer touches it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_ASSETS, RELEASE_ASSETS, SIGNATURE_ASSET, verifyRelease } from './verify-release.mjs';

const DEFAULT_REPO = 'fodaveg/hebra-mantenimiento';
const PLUGIN_ID = 'hebra-mantenimiento';
const WORKFLOW = 'release.yml';
const TAG_RE = /^\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const RUN_APPEAR_ATTEMPTS = 24;
const RUN_APPEAR_WAIT_MS = 5_000;

class Failure extends Error {}

const fail = (message) => {
  throw new Failure(message);
};

export function parseArgs(argv) {
  const out = { repo: DEFAULT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--repo') {
      i += 1;
      out.repo = argv[i];
    } else if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
    else if (out.tag === undefined) out.tag = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (!out.tag || !TAG_RE.test(out.tag)) fail('usage: sign-publish.mjs <tag, like 0.1.0> [--dry-run] [--repo <owner/repo>]');
  if (!out.repo || !REPO_RE.test(out.repo)) fail('--repo needs <owner/repo>');
  return out;
}

/** Runs `gh`; returns stdout (a string, or a Buffer with `binary`). Fails with its last stderr lines. */
function gh(args, { binary = false, what = `gh ${args.slice(0, 2).join(' ')}` } = {}) {
  const result = spawnSync('gh', args, {
    encoding: binary ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    fail(`${what} failed (${result.error?.code ?? `exit ${result.status}`})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`sign-publish: ${message}`);

/** The newest push run of the release workflow for the tag, waiting for it to appear. */
async function findRun({ repo, tag }) {
  for (let attempt = 0; attempt < RUN_APPEAR_ATTEMPTS; attempt += 1) {
    const runs = JSON.parse(
      gh(['run', 'list', '-R', repo, '--workflow', WORKFLOW, '--event', 'push', '--branch', tag, '--limit', '5', '--json', 'databaseId,status,conclusion,headSha,createdAt'])
    );
    runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (runs[0]) return runs[0];
    log(`no workflow run for ${tag} yet, waiting`);
    await sleep(RUN_APPEAR_WAIT_MS);
  }
  return fail(`no ${WORKFLOW} run for tag ${tag} appeared: was the tag pushed?`);
}

async function waitForWorkflow({ repo, tag }) {
  const run = await findRun({ repo, tag });
  if (run.status !== 'completed') {
    log(`waiting for run ${run.databaseId}`);
    // Exit status is 0/1 by the run's result; the real verdict is read below either way.
    spawnSync('gh', ['run', 'watch', String(run.databaseId), '-R', repo, '--exit-status'], { stdio: 'inherit' });
  }
  const done = JSON.parse(gh(['run', 'view', String(run.databaseId), '-R', repo, '--json', 'status,conclusion,headSha,url']));
  if (done.status !== 'completed' || done.conclusion !== 'success') {
    fail(`the workflow run for ${tag} is ${done.status}/${done.conclusion}, not a success: ${done.url}. Nothing was signed or published.`);
  }
  const tagCommit = gh(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']).trim();
  if (done.headSha !== tagCommit) {
    fail(`the run is for ${done.headSha} but tag ${tag} points at ${tagCommit}`);
  }
  log(`workflow green on ${tagCommit}: ${done.url}`);
}

function findDraft({ repo, tag }) {
  const ids = gh(['api', `repos/${repo}/releases`, '--paginate', '--jq', `.[] | select(.draft == true and .tag_name == "${tag}") | .id`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length !== 1) fail(`expected exactly one draft release for ${tag}, found ${ids.length} (already published?)`);
  return ids[0];
}

const listAssets = ({ repo, releaseId }) =>
  JSON.parse(gh(['api', `repos/${repo}/releases/${releaseId}/assets`, '--paginate']));

function downloadAssets({ repo, assets, names, dir }) {
  const files = new Map();
  for (const name of names) {
    const asset = assets.find((a) => a.name === name);
    if (!asset) continue;
    const buffer = gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], { binary: true, what: `download ${name}` });
    writeFileSync(join(dir, name), buffer);
    files.set(name, buffer);
  }
  return files;
}

/** Step 2: the draft holds the three assets the workflow attested, unchanged. Returns the reference. */
function checkDraft({ repo, tag, releaseId, dir }) {
  const assets = listAssets({ repo, releaseId });
  const files = downloadAssets({ repo, assets, names: RELEASE_ASSETS, dir });
  for (const name of RELEASE_ASSETS) {
    if (!files.has(name)) fail(`the draft has no ${name}`);
    gh(['attestation', 'verify', join(dir, name), '--repo', repo, '--signer-workflow', `${repo}/.github/workflows/${WORKFLOW}`], { what: `attestation of ${name}` });
  }
  // The attestation proves each file's hash is the one the workflow built, so those hashes are the reference.
  const reference = new Map([...files].map(([name, buffer]) => [name, sha256(buffer)]));
  const { problems, warnings } = verifyRelease({ reference, assets, files, tag, stage: 'draft' });
  for (const warning of warnings) console.warn(`sign-publish warning: ${warning}`);
  if (problems.length > 0) fail(`the draft does not match the workflow build:\n  ${problems.join('\n  ')}`);
  log(`draft ${tag} has the three assets, attested by the workflow and equal to GitHub's digests`);
  return reference;
}

function sign({ repo, tag, dryRun }) {
  const script = join(process.env.HEBRA_REPO ?? join(homedir(), 'code', 'hebra'), 'scripts', 'firmar-release-plugin.mjs');
  const args = [script, '--plugin', PLUGIN_ID, '--repo', repo, '--tag', tag, ...(dryRun ? ['--sin-subir'] : [])];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) fail('the signer failed: nothing was published');
}

function publish({ repo, tag, releaseId }) {
  const release = JSON.parse(gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${releaseId}`, '-F', 'draft=false'], { what: 'publish' }));
  if (release.draft || release.tag_name !== tag) fail(`release not published as expected (draft=${release.draft}, tag=${release.tag_name})`);
  if (release.immutable !== true) {
    fail(`release ${tag} was published but is NOT immutable: enable immutable releases in the repository settings (Settings > Releases)`);
  }
  log(`published ${release.html_url}, immutable`);
  return release;
}

/** Step 5: what is now public has four assets, the three unchanged plus the signature. */
function checkPublished({ repo, tag, releaseId, reference, dir }) {
  const assets = listAssets({ repo, releaseId });
  const files = downloadAssets({ repo, assets, names: PUBLISHED_ASSETS, dir });
  const { problems, warnings } = verifyRelease({ reference, assets, files, tag, stage: 'published' });
  for (const warning of warnings) console.warn(`sign-publish warning: ${warning}`);
  if (problems.length > 0) fail(`the published release is wrong:\n  ${problems.join('\n  ')}`);
  log(`published ${tag} has ${assets.length} assets: ${assets.map((a) => a.name).sort().join(' ')}`);
}

async function main() {
  const { repo, tag, dryRun } = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), 'mantenimiento-sign-publish-'));
  try {
    await waitForWorkflow({ repo, tag });
    const releaseId = findDraft({ repo, tag });
    const reference = checkDraft({ repo, tag, releaseId, dir });
    sign({ repo, tag, dryRun });
    if (dryRun) {
      log('dry run: signed and verified, nothing uploaded or published');
      return;
    }
    const withSignature = listAssets({ repo, releaseId }).map((a) => a.name).sort();
    if (JSON.stringify(withSignature) !== JSON.stringify(PUBLISHED_ASSETS)) {
      fail(`the draft should now hold ${PUBLISHED_ASSETS.join(', ')} but holds ${withSignature.join(', ')}: not publishing`);
    }
    publish({ repo, tag, releaseId });
    checkPublished({ repo, tag, releaseId, reference, dir });
    log(`done: ${SIGNATURE_ASSET} is part of the immutable release`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    console.error(`sign-publish: ${error.message}`);
    process.exitCode = 1;
  }
}
