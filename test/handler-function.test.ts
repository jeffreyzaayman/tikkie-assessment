import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Stack } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { handlerFunction } from '../lib/handler-function';
import { testApp } from './support/cdk';

// Synthesises one handler and returns the files of its bundled asset.
function bundle(): { dir: string; files: string[] } {
  const app = testApp();
  const stack = new Stack(app, 'Test', { env: { region: 'eu-west-1' } });
  handlerFunction(stack, 'GetPerson', { stage: 'dev', entryFile: 'get-person.ts' });
  const outdir = app.synth().directory;
  const assets = readdirSync(outdir).filter((name) => name.startsWith('asset.'));
  expect(assets).toHaveLength(1);
  const dir = join(outdir, assets[0]!);
  return { dir, files: readdirSync(dir) };
}

describe('handlerFunction bundling', () => {
  const { dir, files } = bundle();

  it('bundles as an ES module (index.mjs) with a source map', () => {
    expect(files.sort()).toEqual(['index.mjs', 'index.mjs.map']);
  });

  it('starts with the require() shim for CommonJS dependencies', () => {
    const code = readFileSync(join(dir, 'index.mjs'), 'utf8');
    expect(code.startsWith("import { createRequire as __createRequire } from 'node:module';")).toBe(
      true,
    );
  });
});
