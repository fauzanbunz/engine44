import Phaser from 'phaser';
import { hitRect, resolveMove } from './worldkit.js';
import { ASSET_BASE } from './paths.js';

/**
 * Hangar NPCs — Professor / Robot Mechanic / Welder.
 *
 * Same rendering convention as the Pilot (player.js): per-direction idle
 * textures + 6-frame walk animations, one PNG per frame, origin at the feet
 * (FEET_ORIGIN_Y) so .y sorts and collides the same way. The difference is
 * there's no keyboard input here — NpcActor is driven externally, either by
 * a WanderController (Professor/Mechanic) or just left to play a single
 * looping animation in place (the stationary Welder).
 */

const DIRS = ['down', 'up', 'left', 'right'];
const FEET_ORIGIN_Y = 0.82;
const NPC_PAD = 9; // collision radius NPCs use against walls/props/each other

const idleKey = (prefix, d) => `${prefix}_idle_${d}`;
const walkKeys = (prefix, d) => [0, 1, 2, 3, 4, 5].map((i) => `${prefix}_walk_${d}_${i}`);

export function preloadNpc(scene, prefix) {
  const P = `${ASSET_BASE}/characters/${prefix}`;
  for (const d of DIRS) {
    const ik = idleKey(prefix, d);
    if (!scene.textures.exists(ik)) scene.load.image(ik, `${P}/idle/${ik}.png`);
    for (const key of walkKeys(prefix, d)) {
      if (!scene.textures.exists(key)) scene.load.image(key, `${P}/walk/${key}.png`);
    }
  }
}

function ensureNpcAnims(scene, prefix) {
  if (scene.anims.exists(`${prefix}-idle-down`)) return;
  for (const d of DIRS) {
    scene.anims.create({
      key: `${prefix}-idle-${d}`,
      frames: [{ key: idleKey(prefix, d), frame: 0 }],
      frameRate: 1,
    });
    scene.anims.create({
      key: `${prefix}-walk-${d}`,
      frames: walkKeys(prefix, d).map((key) => ({ key, frame: 0 })),
      frameRate: 10,
      repeat: -1,
    });
  }
}

/** A walking/idle NPC — visually identical machinery to PilotPlayer, minus
 *  keyboard input. Something else (WanderController) calls setMotionState
 *  each frame to say "I'm moving this way" / "I'm standing still". */
export class NpcActor {
  constructor(scene, prefix, x, y, { scale = 1 } = {}) {
    ensureNpcAnims(scene, prefix);
    this.scene = scene;
    this.prefix = prefix;
    this.facing = 'down';
    this._moving = null;
    this._facingApplied = null;

    this.shadow = scene.add.ellipse(x, y, 22, 10, 0x000000, 0.4).setScale(scale);
    this.sprite = scene.add.sprite(x, y, idleKey(prefix, 'down'))
      .setOrigin(0.5, FEET_ORIGIN_Y)
      .setScale(scale);

    this.setPosition(x, y);
    this._apply(false);
  }

  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }
  setPosition(x, y) {
    this.sprite.setPosition(x, y);
    this.sprite.setDepth(y);
    this.shadow.setPosition(x, y);
    this.shadow.setDepth(y - 0.5);
  }
  setVisible(v) { this.sprite.setVisible(v); this.shadow.setVisible(v); }

  setMotionState(moving, facing) {
    if (facing) this.facing = facing;
    this._apply(moving);
  }

  _apply(moving) {
    if (moving === this._moving && this.facing === this._facingApplied) return;
    this._moving = moving;
    this._facingApplied = this.facing;
    const state = moving ? 'walk' : 'idle';
    const target = `${this.prefix}-${state}-${this.facing}`;
    if (this.sprite.anims?.currentAnim?.key !== target) this.sprite.play(target);
  }
}

/** Simple wander AI: pick a random point within `radius` of home, walk to
 *  it (sliding along obstacles via resolveMove, same as the player), pause
 *  a bit, repeat. Target points are rejection-sampled against the current
 *  obstacle list so it won't deliberately aim itself into a wall or prop —
 *  combined with a sane home/radius this keeps wanderers out of the walled
 *  rooms without needing a hand-authored floor-zone polygon. If a chosen
 *  target turns out to be unreachable (walked into something and stalled),
 *  it just gives up and idles rather than grinding against the obstacle. */
export class WanderController {
  constructor(actor, collider, { homeX, homeY, radius, speed, pauseMin = 900, pauseMax = 2200 }) {
    this.actor = actor;
    this.collider = collider;
    this.homeX = homeX;
    this.homeY = homeY;
    this.radius = radius;
    this.speed = speed;
    this.pauseMin = pauseMin;
    this.pauseMax = pauseMax;
    this.state = 'idle';
    this.pauseTimer = Phaser.Math.Between(pauseMin, pauseMax);
    this.target = null;
    this._syncCollider();
  }

  _syncCollider() {
    const w = this.collider.width;
    const h = this.collider.height;
    this.collider.x = this.actor.x - w / 2;
    this.collider.y = this.actor.y - h;
  }

  _pickTarget(obstacles) {
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 16 + Math.random() * Math.max(1, this.radius - 16);
      const tx = this.homeX + Math.cos(angle) * dist;
      const ty = this.homeY + Math.sin(angle) * dist;
      if (!hitRect(obstacles, tx, ty, NPC_PAD)) return { x: tx, y: ty };
    }
    return { x: this.homeX, y: this.homeY };
  }

  /** @param {number} dt seconds @param {Phaser.Geom.Rectangle[]} obstacles everything solid except this NPC's own collider */
  update(dt, obstacles) {
    if (this.state === 'idle') {
      this.actor.setMotionState(false, this.actor.facing);
      this.pauseTimer -= dt * 1000;
      if (this.pauseTimer <= 0) {
        this.target = this._pickTarget(obstacles);
        this.state = 'moving';
      }
      return;
    }

    const dx = this.target.x - this.actor.x;
    const dy = this.target.y - this.actor.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 3) {
      this.state = 'idle';
      this.pauseTimer = Phaser.Math.Between(this.pauseMin, this.pauseMax);
      this.actor.setMotionState(false, this.actor.facing);
      return;
    }

    const vx = dx / dist;
    const vy = dy / dist;
    const nx = this.actor.x + vx * this.speed * dt;
    const ny = this.actor.y + vy * this.speed * dt;
    const resolved = resolveMove(obstacles, this.actor.x, this.actor.y, nx, ny, NPC_PAD);
    const moved = Math.hypot(resolved.x - this.actor.x, resolved.y - this.actor.y);
    this.actor.setPosition(resolved.x, resolved.y);
    this._syncCollider();

    const facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    this.actor.setMotionState(moved > 0.05, facing);
    if (moved < 0.05) {
      // blocked / stuck against something — bail on this target instead of
      // grinding against the obstacle every frame
      this.state = 'idle';
      this.pauseTimer = Phaser.Math.Between(this.pauseMin, this.pauseMax);
    }
  }
}

// ---------------------------------------------------------------------
// Welder — stationary "at work" pose. Mask DOWN, torch + spark loop, one
// direction only (south) — see the welding/ folder note in HangarScene.
// ---------------------------------------------------------------------

const WELDING_FRAME_COUNT = 8;
const weldingKey = (i) => `npc_welder_welding_south_${i}`;

export function preloadWelderWelding(scene) {
  const P = `${ASSET_BASE}/characters/npc_welder/welding`;
  for (let i = 0; i < WELDING_FRAME_COUNT; i++) {
    const key = weldingKey(i);
    if (!scene.textures.exists(key)) scene.load.image(key, `${P}/${key}.png`);
  }
}

function ensureWeldingAnim(scene) {
  if (scene.anims.exists('npc_welder-welding')) return;
  scene.anims.create({
    key: 'npc_welder-welding',
    frames: Array.from({ length: WELDING_FRAME_COUNT }, (_, i) => ({ key: weldingKey(i), frame: 0 })),
    frameRate: 8,
    repeat: -1,
  });
}

/** A welder fixed at a work post — no wander, no idle/walk, just the
 *  welding loop playing continuously. Positioned/facing is whatever the
 *  single generated direction (south) reads as at that spot; there's no
 *  second direction to rotate into. */
export class StationaryWelder {
  constructor(scene, x, y, { scale = 1 } = {}) {
    ensureWeldingAnim(scene);
    this.shadow = scene.add.ellipse(x, y, 22, 10, 0x000000, 0.4).setScale(scale);
    this.sprite = scene.add.sprite(x, y, weldingKey(0)).setOrigin(0.5, FEET_ORIGIN_Y).setScale(scale);
    this.sprite.setPosition(x, y).setDepth(y);
    this.shadow.setPosition(x, y).setDepth(y - 0.5);
    this.sprite.play('npc_welder-welding');
  }
  setVisible(v) { this.sprite.setVisible(v); this.shadow.setVisible(v); }
}
