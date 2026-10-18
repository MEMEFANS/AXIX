import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

const projectRoot = resolve('.');
const walletOutdir = resolve(projectRoot, 'public/vendor/wallet');
if (!walletOutdir.startsWith(`${projectRoot}${sep}`) || basename(walletOutdir) !== 'wallet') {
  throw new Error(`拒绝清理意外的构建目录: ${walletOutdir}`);
}
await rm(walletOutdir, { recursive:true, force:true });

await build({
  entryPoints:['frontend/wallet-connector.js'],
  bundle:true,
  format:'esm',
  splitting:true,
  target:'es2020',
  outdir:walletOutdir,
  entryNames:'connector',
  chunkNames:'chunks/[name]-[hash]',
  minify:true,
});
