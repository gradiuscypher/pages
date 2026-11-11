import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const require = createRequire(import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'fonts'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { client: 'web/client.js' },
  outdir: output,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'linked',
  logLevel: 'info',
});
await Promise.all(['style.css', 'theme.js'].map((name) => copyFile(resolve(root, 'web', name), resolve(output, name))));
const fontRoot = dirname(require.resolve('@fontsource/ibm-plex-mono/package.json'));
await Promise.all([400, 500, 600].map((weight) => {
  const name = `ibm-plex-mono-latin-${weight}-normal.woff2`;
  return copyFile(resolve(fontRoot, 'files', name), resolve(output, 'fonts', name));
}));
// Preserve the open font's redistribution license beside the bundled files.
await copyFile(resolve(fontRoot, 'LICENSE'), resolve(output, 'fonts', 'LICENSE'));
