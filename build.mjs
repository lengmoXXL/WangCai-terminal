import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const mainOptions = {
  bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked', external: ['@wangcai/sdk'],
  supported: { 'dynamic-import': false },
};
/** @type {import('esbuild').BuildOptions} */
const uiOptions = {
  bundle: true, format: 'esm', target: 'chrome140', jsx: 'automatic', sourcemap: 'linked',
  loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' },
};

// The app loads what this writes: main.cjs runs in the main process, ui.js is the renderer entry and
// ui.css sits next to it. Everything but the SDK is bundled, so the app never needs this repository's
// dependencies and never compiles a plugin itself.
/** @param {string} output */
export async function build(output = import.meta.dirname) {
  const source = import.meta.dirname;
  await esbuild.build({ ...mainOptions, absWorkingDir: source, entryPoints: ['main.ts'], outfile: join(output, 'main.cjs') });
  if (!existsSync(join(source, 'ui.tsx'))) return;
  await esbuild.build({
    ...uiOptions, absWorkingDir: source, outdir: output,
    entryPoints: ['ui.tsx', ...(existsSync(join(source, 'ui.worker.ts')) ? ['ui.worker.ts'] : [])],
    plugins: [{ name: 'node-sdk-boundary', setup(builder) {
      builder.onResolve({ filter: /^@wangcai\/sdk$/ }, () => ({ errors: [{ text: '@wangcai/sdk is only available in main.ts' }] }));
    } }],
  });
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) await build();
