/**
 * Base URL for everything under assets/ — honors Vite's `base` config so
 * the game keeps loading art/video correctly when deployed under a
 * subpath (e.g. a GitHub Pages project site at /reponame/, vs. root at
 * dev time). `import.meta.env.BASE_URL` is guaranteed by Vite to always
 * end in exactly one '/', so this never needs its own slash-joining
 * logic. Every module that hardcoded a literal '/assets/...' string
 * before this existed (HangarScene.js, player.js, npc.js) should import
 * this instead — see vite.config.js's `base` for the other half of this
 * fix (the dev-time middleware and the build-time asset copy both still
 * key off the plain /assets/ prefix; only runtime `fetch`/loader URLs
 * built from JS strings need this, since those never pass through
 * Vite's own base-URL rewriting the way index.html's own script tag does).
 */
export const ASSET_BASE = `${import.meta.env.BASE_URL}assets`;
