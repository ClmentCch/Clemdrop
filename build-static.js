import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'src'), { recursive: true });

for (const file of ['index.html']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}

for (const file of ['config.js', 'main.js', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(out, 'src', file));
}

if (process.env.VITE_SIGNAL_URL) {
  fs.writeFileSync(
    path.join(out, 'src', 'config.js'),
    `window.CLEMDROP_SIGNAL_URL = ${JSON.stringify(process.env.VITE_SIGNAL_URL)};\n`
  );
}

console.log(`Built static site in ${out}`);
