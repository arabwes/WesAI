import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
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

// Minify the shipped CSS/JS. Sources stay readable; only dist/ is minified.
// Top-level names are preserved (classic scripts share globals such as CONFIG).
async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else files.push(full);
  }
  return files;
}

for (const file of await listFiles(outputDir)) {
  const extension = extname(file).toLowerCase();
  if (extension !== '.js' && extension !== '.css') continue;
  const source = await readFile(file, 'utf8');
  const { code } = await transform(source, { loader: extension.slice(1), minify: true, legalComments: 'none' });
  await writeFile(file, code);
}

// Public pages reference assets without a version string, and Pages serves
// .js/.css with a 4-hour max-age (see _headers). Stamp each reference with a
// hash of the built file so a deploy is picked up immediately. Portal pages
// under /team keep their manual ?v=N strings.
const publicAssets = ['/css/styles.css', '/js/script.js', '/js/config.js', '/js/book.js', '/js/inquiry.js'];
const hashes = {};
for (const asset of publicAssets) {
  const content = await readFile(join(outputDir, asset));
  hashes[asset] = createHash('sha256').update(content).digest('hex').slice(0, 10);
}
for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.html') continue;
  const file = join(outputDir, entry.name);
  let html = await readFile(file, 'utf8');
  for (const asset of publicAssets) {
    html = html.replaceAll(`"${asset}"`, `"${asset}?v=${hashes[asset]}"`);
  }
  await writeFile(file, html);
}

console.log(`Pages assets built at ${outputDir}`);
