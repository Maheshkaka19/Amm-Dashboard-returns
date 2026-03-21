import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, 'dist');
const publicDir = path.join(__dirname, 'public');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, 'public'), { recursive: true });
fs.cpSync(publicDir, path.join(distDir, 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'server.mjs'), path.join(distDir, 'server.mjs'));
fs.writeFileSync(
  path.join(distDir, 'build-meta.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      app: 'AMM Pool ALM Dashboard',
      runtimeStartCommand: 'node server.mjs'
    },
    null,
    2,
  ),
);

console.log('Build complete: dist/ and source files retained for App Hosting runtime.');
