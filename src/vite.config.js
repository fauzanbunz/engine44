import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Art lives one level up in <repo>/assets/ — served straight from there at
// the /assets/* URL the game uses (same pattern as the miners project).
const ASSETS_ROOT = path.resolve(__dirname, '../assets');

const MIME = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function serveRepoAssets() {
  return {
    name: 'serve-repo-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/assets/')) return next();
        const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\/assets\//, ''));
        const filePath = path.join(ASSETS_ROOT, rel);
        if (!filePath.startsWith(ASSETS_ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end(`asset not found: ${rel}`);
          return;
        }
        const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        const size = fs.statSync(filePath).size;
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Accept-Ranges', 'bytes');

        // <video> playback (especially seeking, and Safari's initial load)
        // needs real HTTP Range support — without this, a video-element
        // request for a byte range just gets the whole file back with a
        // 200, which some browsers refuse to play at all. Images/JSON
        // never send a Range header, so this only ever engages for video.
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match && match[1] ? parseInt(match[1], 10) : 0;
          const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
          if (!match || start > end || end >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          res.setHeader('Content-Type', contentType);
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', size);
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

// Only these subfolders are actually loaded by game code (grep every
// `${ASSET_BASE}/...` call site in HangarScene.js/player.js/npc.js to
// confirm before adding to this list). ASSETS_ROOT also holds a few
// loose reference/inspiration files dropped directly at its top level
// (concept art, a reference track) that nothing in the game loads —
// listing subfolders explicitly, rather than copying ASSETS_ROOT
// wholesale, keeps those out of the shipped build automatically.
const SHIPPED_ASSET_DIRS = ['characters', 'map', 'portraits', 'video'];

/** `vite build` never runs serveRepoAssets' dev middleware, so without
 *  this the production bundle would ship with every /assets/* request
 *  404ing — the middleware above only ever covered `npm run dev`. This
 *  copies SHIPPED_ASSET_DIRS straight into <outDir>/assets after the
 *  build finishes, so the static output is self-contained (no separate
 *  deploy-time asset-copy step needed — GitHub Actions just uploads
 *  outDir as-is). `apply: 'build'` keeps this from ever touching dev. */
function copyRepoAssetsOnBuild() {
  let outDir;
  return {
    name: 'copy-repo-assets-on-build',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const destRoot = path.join(outDir, 'assets');
      for (const dir of SHIPPED_ASSET_DIRS) {
        fs.cpSync(path.join(ASSETS_ROOT, dir), path.join(destRoot, dir), { recursive: true });
      }
      // GitHub Pages runs everything it serves through Jekyll by default —
      // even on the Actions-based deploy path — which silently drops any
      // top-level file/folder starting with '_' unless this marker is
      // present. build.assetsDir below is named '_app', so without this
      // the entire JS bundle (and, per real-world reports, sometimes the
      // whole deploy) goes missing on GitHub Pages specifically, despite
      // working everywhere else (local build, vite preview, any other host).
      fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
      console.log(`[copy-repo-assets-on-build] ${SHIPPED_ASSET_DIRS.join(', ')} -> ${destRoot}`);
    },
  };
}

export default defineConfig({
  // GitHub Pages project sites (username.github.io/<repo>/, as opposed to
  // a root username.github.io site) serve everything under a /<repo>/
  // subpath — every runtime asset URL the game builds itself (not run
  // through Vite's own import/HTML rewriting) has to know about this,
  // see paths.js's ASSET_BASE (reads this back via import.meta.env.BASE_URL).
  base: '/engine44/',
  plugins: [serveRepoAssets(), copyRepoAssetsOnBuild()],
  // Vite's own hashed JS/CSS output defaults to <outDir>/assets/ too —
  // same folder name our own game art copies into above. They don't
  // actually collide (different filenames), but keeping them apart
  // avoids ever having to reason about that, and makes `dist/assets/`
  // unambiguously "the game's art" on disk.
  build: {
    assetsDir: '_app',
  },
  server: {
    port: 5174,
    host: true,
    open: false,
  },
  clearScreen: false,
});
