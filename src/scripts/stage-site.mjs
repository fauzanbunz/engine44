// Assembles the deployable site in <repo>/deploy/:
//   deploy/index.html  <- landing.html (static, not part of the Vite build)
//   deploy/play/...    <- the built game (src/dist)
// Run after `vite build`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(srcDir, '..');
const landing = path.join(repoRoot, 'landing.html');
const dist = path.join(srcDir, 'dist');
const deploy = path.join(repoRoot, 'deploy');

for (const [label, p] of [['landing page', landing], ['game build (run `vite build` first)', dist]]) {
  if (!fs.existsSync(p)) {
    console.error(`[stage-site] missing ${label}: ${p}`);
    process.exit(1);
  }
}

fs.rmSync(deploy, { recursive: true, force: true });
fs.mkdirSync(deploy, { recursive: true });
fs.copyFileSync(landing, path.join(deploy, 'index.html'));
fs.cpSync(dist, path.join(deploy, 'play'), { recursive: true });
// dist/.nojekyll only covers /play/; GitHub Pages needs it at the site root.
fs.writeFileSync(path.join(deploy, '.nojekyll'), '');
console.log(`[stage-site] ${deploy} ready (index.html + play/)`);
