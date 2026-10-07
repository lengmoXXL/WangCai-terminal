import { join } from 'node:path';
import esbuild from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const mainOptions = {
  bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked',
  supported: { 'dynamic-import': false },
};
/** @type {import('esbuild').BuildOptions} */
const uiOptions = {
  bundle: true, format: 'esm', target: 'chrome140', jsx: 'automatic', sourcemap: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
};

// The app loads what this writes: main.cjs runs in the main process, ui.js is the renderer entry and
// ui.css sits next to it. Everything the runtime needs is bundled, so the app never needs this repository's
// dependencies and never compiles a plugin itself.
const source = import.meta.dirname;
await esbuild.build({ ...mainOptions, absWorkingDir: source, entryPoints: ['main.ts'], outfile: join(source, 'main.cjs') });
await esbuild.build({
  ...uiOptions, absWorkingDir: source, outdir: source,
  entryPoints: ['ui.tsx'],
  plugins: [{ name: 'node-sdk-boundary', setup(builder) {
    builder.onResolve({ filter: /^@lengmoxxl\/sdk$/ }, () => ({ errors: [{ text: '@lengmoxxl/sdk is only available in main.ts' }] }));
  } }],
});
