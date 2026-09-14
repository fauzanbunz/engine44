import Phaser from 'phaser';
import { ASSET_BASE } from './paths.js';

/**
 * The ENGINE 44 Pilot: a single 64x64 sprite (no layering), driven by
 * per-direction idle textures + 6-frame walk animations. Unlike the miners'
 * Player (one composited spritesheet), each Pilot frame is its own PNG file,
 * loaded as its own texture key — Phaser animations can mix frames from
 * different texture keys just fine ({ key, frame } per entry).
 *
 * origin is (0.5, ~0.82) so sprite.y sits near the feet — use it directly
 * for depth sorting and trigger/collision checks, same convention as the
 * miners' Player.container.y.
 */

const DIRS = ['down', 'up', 'left', 'right'];
const FEET_ORIGIN_Y = 0.82;

const IDLE_KEY = {
  down: 'pilot_idle_down', up: 'pilot_idle_up', left: 'pilot_idle_left', right: 'pilot_idle_right',
};
const WALK_KEYS = {
  down: [0, 1, 2, 3, 4, 5].map((i) => `pilot_walk_down_${i}`),
  up: [0, 1, 2, 3, 4, 5].map((i) => `pilot_walk_up_${i}`),
  left: [0, 1, 2, 3, 4, 5].map((i) => `pilot_walk_left_${i}`),
  right: [0, 1, 2, 3, 4, 5].map((i) => `pilot_walk_right_${i}`),
};

export function preloadPilot(scene) {
  const P = `${ASSET_BASE}/characters/pilot`;
  for (const d of DIRS) {
    const idleKey = IDLE_KEY[d];
    if (!scene.textures.exists(idleKey)) scene.load.image(idleKey, `${P}/idle/${idleKey}.png`);
    for (const key of WALK_KEYS[d]) {
      if (!scene.textures.exists(key)) scene.load.image(key, `${P}/walk/${key}.png`);
    }
  }
}

function ensureAnims(scene) {
  if (scene.anims.exists('pilot-idle-down')) return;
  for (const d of DIRS) {
    scene.anims.create({
      key: `pilot-idle-${d}`,
      frames: [{ key: IDLE_KEY[d], frame: 0 }],
      frameRate: 1,
    });
    scene.anims.create({
      key: `pilot-walk-${d}`,
      frames: WALK_KEYS[d].map((key) => ({ key, frame: 0 })),
      frameRate: 10,
      repeat: -1,
    });
  }
}

export class PilotPlayer {
  constructor(scene, x, y, { scale = 1, speed = 150, clampFn = null } = {}) {
    ensureAnims(scene);
    this.scene = scene;
    this.speed = speed;
    this.clampFn = clampFn;
    this.facing = 'down';
    this._moving = null;
    this._facingApplied = null;

    // flat, semi-transparent blob at the feet — not a blurred/gradient shadow,
    // just a solid dark ellipse at reduced opacity, matching the rest of the
    // pixel-art's flat-shading register
    this.shadow = scene.add.ellipse(x, y, 24, 11, 0x000000, 0.45).setScale(scale);

    this.sprite = scene.add.sprite(x, y, IDLE_KEY.down)
      .setOrigin(0.5, FEET_ORIGIN_Y)
      .setScale(scale);

    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });

    this._apply(false);
  }

  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }
  setPosition(x, y) {
    this.sprite.setPosition(x, y);
    this.sprite.setDepth(y);
    this.shadow.setPosition(x, y);
    this.shadow.setDepth(y - 0.5); // just under the sprite, still y-sorted with everything else
  }
  setVisible(v) { this.sprite.setVisible(v); this.shadow.setVisible(v); }
  destroy() { this.sprite.destroy(); this.shadow.destroy(); }

  /** @param {number} dt seconds */
  update(dt) {
    const c = this.cursors;
    const w = this.wasd;
    const left = c.left.isDown || w.left.isDown;
    const right = c.right.isDown || w.right.isDown;
    const up = c.up.isDown || w.up.isDown;
    const down = c.down.isDown || w.down.isDown;

    let vx = (right ? 1 : 0) - (left ? 1 : 0);
    let vy = (down ? 1 : 0) - (up ? 1 : 0);
    const moving = vx !== 0 || vy !== 0;

    if (moving) {
      if (Math.abs(vx) >= Math.abs(vy) && vx !== 0) this.facing = vx > 0 ? 'right' : 'left';
      else if (vy !== 0) this.facing = vy > 0 ? 'down' : 'up';

      if (vx !== 0 && vy !== 0) { const k = 1 / Math.SQRT2; vx *= k; vy *= k; }

      let nx = this.sprite.x + vx * this.speed * dt;
      let ny = this.sprite.y + vy * this.speed * dt;
      if (this.clampFn) ({ x: nx, y: ny } = this.clampFn(nx, ny));
      this.sprite.setPosition(nx, ny);
      this.shadow.setPosition(nx, ny);
    }

    this._apply(moving);
    this.sprite.setDepth(this.sprite.y);        // y-sort against props
    this.shadow.setDepth(this.sprite.y - 0.5);  // just under the sprite
  }

  _apply(moving) {
    if (moving === this._moving && this.facing === this._facingApplied) return;
    this._moving = moving;
    this._facingApplied = this.facing;
    const state = moving ? 'walk' : 'idle';
    const target = `pilot-${state}-${this.facing}`;
    if (this.sprite.anims?.currentAnim?.key !== target) this.sprite.play(target);
  }
}
