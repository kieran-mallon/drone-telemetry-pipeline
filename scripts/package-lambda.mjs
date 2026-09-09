/**
 * Bundle the Lambda handler for deployment.
 *
 * Shipping src/ plus node_modules would make a ~40MB archive; bundled it is
 * closer to 1MB, and Lambda cold start scales with archive size. esbuild also
 * tree-shakes the AWS SDK clients down to the two commands actually used.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';

const outdir = 'dist-lambda';

const result = await build({
  entryPoints: ['src/runtime/lambda.ts'],
  outfile: `${outdir}/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',

  /**
   * CommonJS output, paired with the package.json marker written below.
   *
   * This project is ESM ("type": "module"), which would make Node and Lambda
   * treat dist-lambda/index.js as ESM too. It is not, so the handler export
   * would silently resolve to nothing and every invocation would fail with
   * "Cannot find module 'index'". Emitting CJS and declaring it explicitly in
   * the output directory removes the ambiguity.
   */
  format: 'cjs',

  minify: true,
  sourcemap: true,
  // Source maps are only useful if the runtime is told to read them; the Lambda
  // sets NODE_OPTIONS=--enable-source-maps for exactly this.

  external: [
    // Optional native binding for pg. Never installed here, and requiring it is
    // guarded, but esbuild would fail trying to resolve it.
    'pg-native',
    // Development-only Pino transport. Only loaded when AWS_ENDPOINT_URL is
    // set, which never happens in a real deployment.
    'pino-pretty',
  ],

  logLevel: 'info',
  metafile: true,
});

mkdirSync(outdir, { recursive: true });
writeFileSync(`${outdir}/package.json`, `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`\nbundled ${outdir}/index.js (${(bytes / 1024 / 1024).toFixed(2)} MB total)`);
