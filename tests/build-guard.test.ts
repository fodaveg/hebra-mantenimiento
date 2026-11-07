import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs without types
import { guardBundle } from '../scripts/build-hebra.mjs';

const metafile = { outputs: { 'hebra-main.mjs': { imports: [], inputs: {} } } };
const OK = 'export { activate };\nfunction activate() {}\n';

describe('guardBundle', () => {
  it('acepta un módulo autocontenido que exporta activate', () => {
    expect(guardBundle(OK, metafile)).toEqual([]);
  });

  it('rechaza una llamada prohibida (el build fallaría)', () => {
    const problems = guardBundle(`${OK}api.vault.noteTrash(id);`, metafile) as string[];
    expect(problems.some((p) => p.includes('noteTrash'))).toBe(true);
  });

  it('rechaza un import dinámico, node: y la falta de activate', () => {
    expect(guardBundle('import("./x.js");', metafile).length).toBeGreaterThan(0);
    expect((guardBundle(`${OK}const a = "node:fs";`, metafile) as string[]).join()).toContain('node:fs');
    expect((guardBundle('const x = 1;', metafile) as string[]).join()).toContain('activate');
  });
});

describe('verify-release', () => {
  it('espera exactamente tres ficheros y la firma al publicar', async () => {
    // @ts-expect-error -- plain .mjs without types
    const mod = (await import('../scripts/verify-release.mjs')) as {
      RELEASE_ASSETS: string[];
      PUBLISHED_ASSETS: string[];
    };
    expect(mod.RELEASE_ASSETS).toEqual(['hebra-main.mjs', 'hebra-styles.css', 'hebra.json']);
    expect(mod.PUBLISHED_ASSETS).toEqual([...mod.RELEASE_ASSETS, 'hebra.json.minisig'].sort());
  });
});
