import Phaser from 'phaser';

/**
 * ENGINE 44 — dialogue system foundation.
 *
 * Two pieces:
 *  - DialogueBox: a fixed-to-camera mecha/HUD-styled popup with a hex-framed
 *    portrait, name label, and line-by-line text. Advances on Space/Enter or
 *    click; closes itself after the last line.
 *  - AskIndicator: a small floating "ASK" badge shown above an NPC's head
 *    when the player is in interaction range.
 *
 * This is plumbing only — no story content lives here. Callers pass in
 * {name, portraitKey, lines} per interaction; HangarScene owns deciding
 * WHEN an NPC is in range and WHICH lines to show.
 */

const ACCENT = 0xff7a33; // rust/orange Forge Command accent
const PANEL_BG = 0x0b0e12;

/** an angular (chamfered-corner) panel outline, drawn into a Graphics
 *  object already positioned where the caller wants it — reads as a
 *  cockpit-HUD bezel rather than a soft rounded RPG box. */
export function drawAngularPanel(g, w, h, { fill = PANEL_BG, fillAlpha = 0.88, line = ACCENT, lineAlpha = 1, chamfer = 14 } = {}) {
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const pts = [
    { x: x0 + chamfer, y: y0 }, { x: x1 - chamfer, y: y0 },
    { x: x1, y: y0 + chamfer }, { x: x1, y: y1 - chamfer },
    { x: x1 - chamfer, y: y1 }, { x: x0 + chamfer, y: y1 },
    { x: x0, y: y1 - chamfer }, { x: x0, y: y0 + chamfer },
  ];
  g.fillStyle(fill, fillAlpha);
  g.fillPoints(pts, true);
  g.lineStyle(2, line, lineAlpha);
  g.strokePoints(pts, true);
  // small corner accent ticks, cockpit-HUD flavor
  g.lineStyle(2, line, lineAlpha);
  const tick = 8;
  g.lineBetween(x0 + chamfer + 4, y0 + 4, x0 + chamfer + 4 + tick, y0 + 4);
  g.lineBetween(x1 - chamfer - 4, y1 - 4, x1 - chamfer - 4 - tick, y1 - 4);
}

function hexPoints(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Phaser.Math.DegToRad(60 * i - 90);
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

export class DialogueBox {
  constructor(scene) {
    this.scene = scene;
    this.isOpen = false;
    this.lines = [];
    this.lineIndex = 0;

    const { width, height } = scene.scale;
    this.panelW = Math.min(720, width - 40);
    this.panelH = 132;
    const cx = width / 2;
    const cy = height - this.panelH / 2 - 14;

    const DEPTH = 2_000_000;
    this.container = scene.add.container(cx, cy).setScrollFactor(0).setDepth(DEPTH).setVisible(false);

    const panel = scene.add.graphics();
    drawAngularPanel(panel, this.panelW, this.panelH);
    this.container.add(panel);

    // ---- portrait: hex backing + character bust + hex border. The bust
    // crop already has a transparent background (cropped straight from the
    // character's own sprite sheet), so it reads as "framed" just by
    // sitting inside the hex outline — no geometry mask needed. ----
    const portraitR = 46;
    const portraitX = -this.panelW / 2 + 66;
    const portraitBacking = scene.add.graphics();
    portraitBacking.fillStyle(0x000000, 0.6);
    portraitBacking.fillPoints(hexPoints(portraitR), true);
    portraitBacking.setPosition(portraitX, 0);
    this.container.add(portraitBacking);

    this.portraitImage = scene.add.image(portraitX, 2, '__DEFAULT').setVisible(false);
    this.container.add(this.portraitImage);

    const portraitBorder = scene.add.graphics();
    portraitBorder.lineStyle(2, ACCENT, 1);
    portraitBorder.strokePoints(hexPoints(portraitR), true);
    portraitBorder.setPosition(portraitX, 0);
    this.container.add(portraitBorder);

    // ---- name label + body text, right of the portrait ----
    const textX = portraitX + portraitR + 24;
    const textW = this.panelW / 2 - (textX - (-this.panelW / 2)) - 24;

    this.nameText = scene.add.text(textX, -this.panelH / 2 + 18, '', {
      fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
      fontSize: '16px',
      color: '#ff7a33',
    }).setOrigin(0, 0.5);
    this.container.add(this.nameText);

    this.bodyText = scene.add.text(textX, -this.panelH / 2 + 44, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '15px',
      color: '#e9e7e0',
      wordWrap: { width: textW },
      lineSpacing: 4,
    }).setOrigin(0, 0);
    this.container.add(this.bodyText);

    this.continueHint = scene.add.text(this.panelW / 2 - 16, this.panelH / 2 - 14, '▼ SPACE', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '11px',
      color: '#8a8f96',
    }).setOrigin(1, 1);
    this.container.add(this.continueHint);

    // NOTE: Space/Enter are NOT bound here — HangarScene owns them in one
    // place (see handleInteractKey) so "close on last line" and "open a
    // new conversation" can't both fire off the same keypress. Click-to-
    // advance has no such conflict (it never opens anything), so it's
    // wired directly.
    scene.input.on('pointerdown', () => { if (this.isOpen) this.advance(); });
  }

  /** @param {() => void} [onClose] fires once, right when this conversation
   *  closes (whether by finishing the last line or — not currently
   *  possible, there's no cancel — in the future). Beat-completion side
   *  effects (set a flag, update the objective banner) hang off this
   *  rather than off open() itself, so they land after the player has
   *  actually read the lines, not the instant the box appears. */
  open(name, portraitKey, lines, onClose) {
    this.lines = lines;
    this.lineIndex = 0;
    this.isOpen = true;
    this._onClose = onClose || null;
    this.nameText.setText(name.toUpperCase());
    if (portraitKey && this.scene.textures.exists(portraitKey)) {
      this.portraitImage.setTexture(portraitKey).setVisible(true);
      const tex = this.scene.textures.get(portraitKey).getSourceImage();
      const scale = Math.min((92) / tex.width, (92) / tex.height);
      this.portraitImage.setScale(scale);
    } else {
      this.portraitImage.setVisible(false);
    }
    this._showLine();
    this.container.setVisible(true);
  }

  _showLine() {
    this.bodyText.setText(this.lines[this.lineIndex] ?? '');
  }

  /** advance to the next line, or close if that was the last one. Also
   *  used as the "start conversation" trigger — pressing the same key
   *  while in range of an NPC opens the box (see HangarScene). */
  advance() {
    if (!this.isOpen) return;
    this.lineIndex += 1;
    if (this.lineIndex >= this.lines.length) { this.close(); return; }
    this._showLine();
  }

  close() {
    this.isOpen = false;
    this.container.setVisible(false);
    const cb = this._onClose;
    this._onClose = null;
    cb?.();
  }
}

/** a small floating "ASK" badge — same angular-HUD language as the
 *  dialogue box, shrunk down. Hidden by default; HangarScene toggles it
 *  based on player distance each frame and repositions it above whichever
 *  NPC it belongs to (movement matters for wanderers, not welders, but
 *  it's cheap enough to just always follow).
 *
 *  IMPORTANT: this container has no setScrollFactor(0) — deliberately.
 *  Unlike DialogueBox/ObjectiveBanner (screen-fixed HUD, rendered by the
 *  static uiCamera), this tracks a moving WORLD position, so it must
 *  render through the same scrolling/zoomed main camera as the NPC it
 *  follows. Earlier it was mistakenly added to scene.uiObjects (the
 *  uiCamera's render list) — its position was then set to raw world
 *  coordinates but painted by a camera sitting at a fixed scroll/zoom,
 *  so it landed wherever that world point happened to fall in the UI
 *  camera's static frame instead of above the NPC. Don't add this
 *  container to uiObjects. */
export class AskIndicator {
  constructor(scene, labelText = 'ASK') {
    this.scene = scene;
    const g = scene.add.graphics();
    drawAngularPanel(g, 46, 20, { chamfer: 6, fillAlpha: 0.8 });
    const label = scene.add.text(0, 0, labelText, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '11px',
      color: '#ff7a33',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.container = scene.add.container(0, 0, [g, label]).setDepth(999997).setVisible(false);
    this._bobT = Math.random() * Math.PI * 2;
  }

  setVisible(v) { this.container.setVisible(v); }

  /** x,y = the NPC's feet position; the badge floats above their head. */
  update(x, y, dt) {
    this._bobT += dt * 3;
    const bob = Math.sin(this._bobT) * 2;
    this.container.setPosition(x, y - 46 + bob);
    this.container.setDepth(y + 1);
  }

  destroy() { this.container.destroy(); }
}
