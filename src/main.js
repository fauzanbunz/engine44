import Phaser from 'phaser';
import { HangarScene } from './scenes/HangarScene.js';

/**
 * ENGINE 44 — Hangar milestone.
 * Phaser 4 + Vite, orthogonal top-down (not isometric). One HangarScene with
 * two connected areas (ground floor / upper catwalk) — see HangarScene.js.
 */
const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: 960,
  height: 640,
  backgroundColor: '#101214',
  pixelArt: true,
  roundPixels: true,
  // FIT keeps the 960x640 logical size (all UI is laid out against it) and
  // scales the canvas to whatever #game's box is — see index.html for how
  // that box is sized on desktop vs touch devices.
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [HangarScene],
};

const game = new Phaser.Game(config);

if (import.meta.env.DEV) window.__game = game;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.destroy(true);
  });
}
