import { cp, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(projectRoot, 'dist');
const publicDirectories = ['css', 'images', 'js', 'team'];
const publicRootExtensions = new Set(['.html', '.ico', '.png', '.svg', '.txt', '.webmanifest', '.xml']);
const publicRootNames = new Set(['_headers', '_redirects']);

if (dirname(outputDir) !== projectRoot || outputDir === projectRoot) {
  throw new Error(`Unsafe Pages output directory: ${outputDir}`);
}

function isPublicPath(source) {
  const parts = relative(projectRoot, source).split(sep);
  const extension = extname(source).toLowerCase();
  return !parts.some((part) => part.startsWith('.')) && !['.gs', '.md'].includes(extension);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const extension = extname(entry.name).toLowerCase();
  if (!publicRootExtensions.has(extension) && !publicRootNames.has(entry.name)) continue;
  await copyFile(join(projectRoot, entry.name), join(outputDir, entry.name));
}

for (const directory of publicDirectories) {
  await cp(join(projectRoot, directory), join(outputDir, directory), {
    recursive: true,
    filter: isPublicPath
  });
}

console.log(`Pages assets built at ${outputDir}`);
