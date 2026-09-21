import Phaser from 'phaser';
import { PilotPlayer, preloadPilot } from '../player.js';
import { resolveMove } from '../worldkit.js';
import { NpcActor, WanderController, StationaryWelder, preloadNpc, preloadWelderWelding } from '../npc.js';
import { DialogueBox, AskIndicator } from '../dialogue.js';
import { playVideoOverlay } from '../video.js';
import { createTouchControls, isTouchDevice } from '../touch.js';
import { ASSET_BASE } from '../paths.js';
import {
  createStoryState, resolveNpcDialogue, createTerminalInteractable,
  ObjectiveBanner, StoryToast, NPC_DIALOGUE, INTRO_LINES, showEndScreen,
} from '../story.js';

/**
 * ENGINE 44 — HangarScene.
 *
 * A single Phaser.Scene holding TWO connected areas — Level 1 (ground floor)
 * and Level 2 (upper catwalk) — built at the same time, at the same local
 * origin, with only one active/visible at once. "Going upstairs" is NOT a
 * scene.start() reload (see the miners' Village->Mine for that pattern) —
 * here it's the lighter version the brief asked for: fade out, swap which
 * level's group is visible + which colliders are active, reposition the
 * player at the target level's spawn, swap camera bounds, fade in.
 *
 * Orthogonal top-down (not isometric, unlike the miners project) — matches
 * the "low top-down" view the Pilot + hangar tiles were generated in.
 *
 * depth = world Y for every prop the player can walk in front of/behind,
 * same y-sort convention as the miners project.
 *
 * Revision 2 — map scaled to ~70% (Level 1 fully; Level 2 kept at its
 * original height, see note by L2 below), mecha +30% scale, more/spread
 * props, crane truck swapped for a plain ladder, an explicit railing
 * barrier in front of the mecha, more terminals, closer camera zoom.
 */

const TILE = 32;
const PLAYER_R = 10;
const WALL_T = TILE; // wall/railing band thickness
const DEBUG = false;  // draw colliders + trigger zone + a HUD
const MECHA_SCALE = 1.3;

// Per-level control hint (top-left, always shown — independent of DEBUG).
// `move` is swapped for the touch wording on touch devices.
const LEVEL_HINTS = {
  level0: 'walk into the ladder to go back up to L1',
  level1: 'ladder up to L2 · floor hatch down to L0',
  level2: 'east ladder down to L1 · west hatch down to L3',
  level3: 'walk into the ladder to go back up to L2',
  dock: 'find the Operator west along the dock',
};

// The landing page (if it opened this tab) ducks its music while the intro
// plays and restores it on this message. Sent once, either when the intro
// ends/is skipped or — fallback — when the tab is closed/navigated away
// before that happened, so the landing page is never left stuck ducked.
// pagehide (not visibilitychange) is the "tab is going away" signal:
// visibilitychange also fires on a mere tab switch, which would restore
// the landing music while the intro video is still playing.
let introNotified = false;
function notifyOpenerIntroFinished() {
  if (introNotified) return;
  introNotified = true;
  if (window.opener) window.opener.postMessage({ type: 'engine44-intro-finished' }, window.location.origin);
}

// ---- Level 1 — Ground Floor (588x378 — a further 40% reduction from the
// previous 980x630; rooms/corridors packed tighter, prop sizes unchanged) --
const L1 = {
  w: 588, h: 378,
  mechaX: 294,                            // mecha's own center — no longer shares
                                           // MECHA_CENTER_X with L2 now that the two
                                           // levels are different widths (the two
                                           // halves were never on screen together
                                           // anyway, so losing the shared x is fine)
  spawn: { x: 294, y: 330 },              // bottom of the main painted path, directly
                                           // south of the mecha — matches the reference
                                           // concept's player-at-the-foot-of-the-path pose
  upLadder: { x: 535, y: 75 },            // top-right corner, tucked into storage —
                                           // moved up from the open area below so it
                                           // reads as "topmost right" per the user's ask
  upLadderReturn: { x: 535, y: 60 },      // where the player LANDS, arriving from L2 —
                                           // a step away from the ladder's own collider
                                           // (spawning flush against it would overlap
                                           // the inflated collider check on arrival)
  downLadder: { x: 500, y: 335 },         // bottom-right open floor — a dark floor hole
                                           // with just the ladder's top poking out of it,
                                           // the way DOWN to Level 0 (control room, below
                                           // the hangar — not an upstairs room)
  downLadderReturn: { x: 500, y: 320 },   // where the player LANDS, arriving back up
                                           // from L0 — a step north of the hole
};

// ---- Level 2 — Upper Catwalk ------------------------------------------------
// Width scaled to 70% (980, matches L1 for the mecha's shared x-center).
// Height is NOT scaled down — kept at the original 340. The 30%-bigger mecha
// upper crop plus a walkable band beneath it didn't fit in a shrunk corridor
// (see the mecha-size revision below), so this axis was left alone rather
// than squeezing the catwalk unplayably thin.
const L2 = {
  w: 980, h: 340,
  // barrierY sits flush at the base of the mecha_upper's feet: WALL_T (the
  // mecha is placed flush against the north wall, zero gap) + its collision
  // height (120 native * MECHA_SCALE) + 8 (half the barrier's own 16px
  // thickness, so the barrier's top edge — not its center — touches the
  // mecha's collision bottom). Everything north of this is the
  // (unreachable) blank mecha bay; everything south is the walkable
  // catwalk. Referenced by both zones below.
  barrierY: WALL_T + 120 * MECHA_SCALE + 8,
  ladder: { x: 900, y: 306 },           // the functional "back down" connector prop
  ladderArrival: { x: 900, y: 230 },    // where the player LANDS, arriving from L1 —
                                         // south of the barrier (so they land in the
                                         // walkable catwalk, not stuck behind it) and
                                         // clear of the ladder's own trigger zone
                                         // (landing inside it would re-fire immediately
                                         // once the grace period ends)
  downLadder: { x: 55, y: 252 },        // the way DOWN to Level 3 (commander room) —
                                         // the old decorative maintenance-nook ladder,
                                         // moved flush against the west wall at the
                                         // catwalk's vertical middle, now a real
                                         // connector with a floor hole under it
  downLadderReturn: { x: 55, y: 236 },  // where the player lands, arriving back up
                                         // from L3 — a step north of the hole
};

const L2_MECHA_X = 490; // L2's mecha center (L1 now uses L1.mechaX — see note above)

// ---- Dock — the ending corridor -----------------------------------------
// A long, narrow single-file walkway reached only by a scripted transition
// (not a ladder/hatch trigger) right after the wallet form on L2 is
// submitted — the player crosses it to reach the Operator, who closes out
// the current story build. There's no way back and no further connector,
// so unlike L0-L3 above this has no upLadder/downLadder fields at all.
//
// h=340 (not something short like ~190) despite the "narrow corridor"
// brief — matches L2's own height, both chosen so the level's own bounds
// fill the camera's zoom-2 viewport (canvas 640 / zoom 2 = 320 world
// units tall; anything shorter than that leaves the camera clamped short
// of the bounds and showing bare clear-color past its edges, a real gap
// confirmed via an actual screenshot at h=190 before this was bumped up).
// The "narrow, single-file" read instead comes from WALKWAY_H below: a
// slim walkable band sealed off top and bottom by invisible block
// colliders (same trick L0/L3 use for their console decks), with the
// background art filling the taller margins above/below it purely as
// unreachable dressing — see buildDock().
const WALKWAY_H = 130;
const DOCK = {
  w: 1800, h: 340,
  walkwayTop: (340 - WALKWAY_H) / 2,
  walkwayBottom: (340 - WALKWAY_H) / 2 + WALKWAY_H,
  spawn: { x: 1680, y: 170 },    // right end — where the player arrives, facing left
  operator: { x: 120, y: 170 },  // left end — the Operator's fixed post, facing right
};

// ---- Level 0 — Control Room ---------------------------------------------
// A single self-contained room reached by a floor hatch DOWN from L1 (not
// an upstairs room off L2 — it sits below the hangar). Map footprint is
// 273x208 — the 210x160 half-size draft, bumped back up 30% for breathing
// room. A command-table centerpiece + a large hexagonal viewport frame set
// into the north wall with a flat black (empty) interior, left for the
// user to drop their own image behind later — deliberately NOT filled in
// here.
const L0 = {
  w: 273, h: 208,
  spawn: { x: 165, y: 155 },              // the story now OPENS here — Pilot
                                           // standing alone mid-floor, clear of
                                           // the holo-table and the up-ladder
  upLadder: { x: 215, y: 150 },          // the way back UP to L1 — a plain ladder
                                          // against the east wall, same non-solid
                                          // "trigger does the work" treatment as
                                          // L1's own up-ladder to L2
  upLadderArrival: { x: 215, y: 134 },   // where the player lands, arriving down
                                          // from L1 — a step north of the ladder
};

// ---- Level 3 — Commander Room -------------------------------------------
// A ship's-bridge room reached by a floor hatch DOWN from L2 (same hole
// convention as L1->L0). Wide panoramic viewport up top, a captain's chair
// flanked by two console-and-chair pairs on each side, and a tactical
// holo-table further south.
const L3 = {
  w: 460, h: 280,
  upLadder: { x: 60, y: 230 },           // the way back UP to L2 — a plain ladder,
                                          // same non-solid "trigger does the work"
                                          // treatment as L0's own up-ladder to L1
  upLadderArrival: { x: 60, y: 214 },    // where the player lands, arriving down
                                          // from L2 — a step north of the ladder
};

export class HangarScene extends Phaser.Scene {
  constructor() {
    super('HangarScene');
  }

  preload() {
    preloadPilot(this);
    preloadNpc(this, 'npc_professor');
    preloadNpc(this, 'npc_mechanic');
    preloadNpc(this, 'npc_welder');
    preloadWelderWelding(this);
    preloadNpc(this, 'npc_commander');
    preloadNpc(this, 'npc_operator');

    // Dialogue portraits — head-only crops of each character's own idle
    // sprite.
    const P = `${ASSET_BASE}/portraits`;
    this.load.image('portrait_pilot', `${P}/portrait_pilot.png`);
    this.load.image('portrait_professor', `${P}/portrait_professor.png`);
    this.load.image('portrait_mechanic', `${P}/portrait_mechanic.png`);
    this.load.image('portrait_welder', `${P}/portrait_welder.png`);
    this.load.image('portrait_commander', `${P}/portrait_commander.png`);
    this.load.image('portrait_operator', `${P}/portrait_operator.png`);

    const H = `${ASSET_BASE}/map/hangar`;
    // Level 1
    this.load.image('tile_floor', `${H}/level1_ground/tile_floor.png`);
    this.load.image('tile_wall', `${H}/level1_ground/tile_wall.png`);
    this.load.image('workbench', `${H}/level1_ground/workbench.png`);
    this.load.image('tool_rack', `${H}/level1_ground/tool_rack.png`);
    this.load.image('crate_stack_a', `${H}/level1_ground/crate_stack_a.png`);
    this.load.image('crate_stack_b', `${H}/level1_ground/crate_stack_b.png`);
    this.load.image('crate_stack_c', `${H}/level1_ground/crate_stack_c.png`);
    this.load.image('supply_cart', `${H}/level1_ground/supply_cart.png`);
    // Level 2
    this.load.image('tile_grating', `${H}/level2_catwalk/tile_grating.png`);
    this.load.image('terminal', `${H}/level2_catwalk/terminal.png`);
    this.load.image('wall_monitor_a', `${H}/level2_catwalk/wall_monitor_a.png`);
    this.load.image('wall_monitor_b', `${H}/level2_catwalk/wall_monitor_b.png`);
    this.load.image('mecha_bay_bg', `${H}/level2_catwalk/mecha_bay_bg.png`);
    // Level 0 (control room) — assets kept under the old level3_control
    // folder name; only the in-game floor number changed
    this.load.image('hex_frame', `${H}/level3_control/hex_frame.png`);
    this.load.image('holo_table', `${H}/level3_control/holo_table.png`);
    // Level 3 (commander room)
    this.load.image('bridge_window', `${H}/level3_bridge/bridge_window.png`);
    this.load.image('captain_chair', `${H}/level3_bridge/captain_chair.png`);
    // Centerpiece
    this.load.image('mecha_lower', `${H}/centerpiece/mecha_lower.png`);
    this.load.image('mecha_upper', `${H}/centerpiece/mecha_upper.png`);
    // Shared / connectors
    this.load.image('ladder', `${H}/shared_props/ladder.png`);
    this.load.image('banner', `${H}/shared_props/banner.png`);
    this.load.image('tile_fence', `${H}/shared_props/tile_fence.png`);
    this.load.image('tile_divider', `${H}/shared_props/tile_divider.png`);
    this.load.image('wall_endcap', `${H}/shared_props/wall_endcap.png`);
    this.load.image('truss', `${H}/shared_props/truss.png`);
    this.load.image('beacon_lamp', `${H}/shared_props/beacon_lamp.png`);
    // Variety props — scattered across both levels for density
    const V = `${H}/shared_props/variety`;
    this.load.image('storage_locker', `${V}/storage_locker.png`);
    this.load.image('safe', `${V}/safe.png`);
    this.load.image('shelving_unit', `${V}/shelving_unit.png`);
    this.load.image('filing_cabinet', `${V}/filing_cabinet.png`);
    this.load.image('warning_poster', `${V}/warning_poster.png`);
    this.load.image('fire_extinguisher', `${V}/fire_extinguisher.png`);
    this.load.image('desk', `${V}/desk.png`);
    this.load.image('office_chair', `${V}/office_chair.png`);
    this.load.image('bookshelf', `${V}/bookshelf.png`);
    this.load.image('side_table', `${V}/side_table.png`);
    this.load.image('potted_plant', `${V}/potted_plant.png`);
    this.load.image('cable_spool', `${V}/cable_spool.png`);
    this.load.image('whiteboard', `${V}/whiteboard.png`);
    this.load.image('storage_bin', `${V}/storage_bin.png`);
    this.load.image('steel_drum', `${V}/steel_drum.png`);

    this.load.on('loaderror', (f) => console.error('[HangarScene load error]', f.src));
  }

  create() {
    this.cameras.main.setBackgroundColor('#101214');
    this._transitioning = false;
    this._enteredAt = this.time.now;

    // fixed-to-screen UI (dialogue box, ASK indicators, objective banner,
    // toast) — populated below, consumed by the UI-camera setup at the
    // end of create()
    this.uiObjects = [];

    // ---- story state: opening-sequence flags + the two small HUD
    // widgets (persistent objective banner, transient confirmation
    // toast) it drives. See story.js for the full beat/gate breakdown. ----
    this.story = createStoryState();
    this._playerLocked = true; // player can't move until the intro finishes
    this._formOpen = false;    // true while a DOM form overlay is open

    this.level1 = this.buildLevel1();
    this.level2 = this.buildLevel2();
    this.level0 = this.buildLevel0();
    this.level3 = this.buildLevel3();
    this.dock = this.buildDock();
    this.populateNpcs();

    // ---- the story now OPENS on Level 0 (Control Room), not Level 1 ----
    this.active = 'level0';
    HangarScene.setLevelVisible(this.level1, false);
    HangarScene.setLevelVisible(this.level2, false);
    HangarScene.setLevelVisible(this.level3, false);
    HangarScene.setLevelVisible(this.dock, false);
    this.colliders = this.level0.colliders;

    // ---- player ----
    this.player = new PilotPlayer(this, L0.spawn.x, L0.spawn.y, {
      scale: 1,
      speed: 112, // 160 * 0.7 — walking speed slowed 30%
      clampFn: (x, y) => this.resolveMove(x, y),
    });

    // ---- camera ----
    this.setCameraBounds(this.level0.bounds);
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(L0.spawn.x, L0.spawn.y);
    this.cameras.main.roundPixels = true;

    if (DEBUG) this.buildDebug();

    // ---- dialogue system ----
    this.dialogue = new DialogueBox(this);
    this.uiObjects.push(this.dialogue.container);
    this._nearestInteractable = null;
    this.input.keyboard.on('keydown-SPACE', () => this.handleInteractKey());
    this.input.keyboard.on('keydown-ENTER', () => this.handleInteractKey());
    createTouchControls(() => this.handleInteractKey());

    // ---- control hint: small top-left text, always on (not part of the
    // debug overlay). Wrapped to 224px so it stays left of the centered
    // objective banner (which starts at x=240). Rendered by the UI camera. ----
    this.hintText = this.add.text(8, 8, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px',
      color: '#b8bec4', backgroundColor: '#00000080', padding: { x: 5, y: 3 },
      wordWrap: { width: 224 },
    }).setScrollFactor(0).setDepth(1_800_000);
    this.uiObjects.push(this.hintText);
    this._hintLevel = null;

    // ---- objective banner + confirmation toast ----
    this.objectiveBanner = new ObjectiveBanner(this);
    this.uiObjects.push(this.objectiveBanner.container);
    this.toast = new StoryToast(this);
    this.uiObjects.push(this.toast.container);

    // ---- Level 2 launch terminals: not NPCs, so they're registered
    // directly rather than through addInteractable/NPC_DIALOGUE. All
    // three of the terminal bank facing the mecha (390/490/590, y250 —
    // see buildLevel2) do the same thing — the player shouldn't have to
    // find the one "special" middle terminal, any of the three works.
    // Each gets its own createTerminalInteractable() call (so each has
    // its own ASK indicator to track), all sharing the same story state,
    // so submitting at any one of them advances the same gate. Only
    // actually usable (ASK shows) once the relevant story gate opens. ----
    this.level2TerminalInteractables = [390, 490, 590].map((x) => {
      const term = createTerminalInteractable(this, this.story, x, 250);
      this.level2.objects.push(term.indicator.container);
      this.level2.interactables.push(term);
      return term;
    });

    // ---- ambient screen shake: a small "distant impact" tremor every 30s,
    // no story trigger yet — just atmosphere. Phaser's built-in camera
    // shake already gives a small random offset over the duration, which
    // is exactly the "tremor, not earthquake" read at this intensity.
    // (Separate from — and keeps running alongside — the one deliberate
    // shake the intro triggers below, which reuses this same effect.) ----
    this.time.addEvent({
      delay: 30000, loop: true,
      callback: () => this.cameras.main.shake(2000, 0.004),
    });

    // ---- UI camera split: scrollFactor(0) alone does NOT cancel camera
    // zoom in this Phaser version — a fixed-position object still gets
    // scaled/shifted by the main camera's zoom (it only cancels scroll),
    // which pushed the dialogue box and ASK indicators off-screen at the
    // real gameplay zoom. Fix: a second, static, zoom-1 camera renders
    // ONLY the UI objects; the main camera renders everything ELSE. Taken
    // as a one-time snapshot here since every game object already exists
    // by this point in create() — nothing is added to the display list
    // later at runtime. ----
    const worldObjects = this.children.list.filter((o) => !this.uiObjects.includes(o));
    this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height).setName('ui');
    this.uiCamera.ignore(worldObjects);
    this.cameras.main.ignore(this.uiObjects);

    // ---- intro video plays first, full-screen over the canvas (see
    // video.js) — the opening sequence below (fade-in/shake/dialogue)
    // only starts once it ends, is skipped, or fails to load. Everything
    // this scene needs is already built above by this point (preload()'s
    // assets finish loading before Phaser ever calls create()), so the
    // video is the only thing the player is waiting on here. ----
    window.addEventListener('pagehide', notifyOpenerIntroFinished);
    window.addEventListener('beforeunload', notifyOpenerIntroFinished);
    playVideoOverlay(`${ASSET_BASE}/video/intro.mp4`, () => {
      notifyOpenerIntroFinished();
      this.startOpeningSequence();
    });

    console.log('[HangarScene] ready — spawn', L0.spawn, '| levels: level0 (control room), level1 (ground), level2 (catwalk), level3 (commander room)');
  }

  /** black screen -> slow fade-in on the Pilot alone in the Control Room
   *  -> a beat of quiet -> one screen-shake -> Pilot's self-talk ->
   *  objective banner appears -> player regains control. Player movement
   *  stays locked (_playerLocked) for the entire chain, not just while
   *  the dialogue box is open. Split out of create() so the intro video
   *  overlay (see video.js) can gate when this actually starts, without
   *  the fade/shake/dialogue logic itself needing to know a video was
   *  ever involved. */
  startOpeningSequence() {
    this.cameras.main.fadeIn(2200, 0, 0, 0);
    this.cameras.main.once('camerafadeincomplete', () => {
      this.time.delayedCall(2200, () => {
        this.cameras.main.shake(2000, 0.004);
        this.cameras.main.once('camerashakecomplete', () => {
          this.dialogue.open('Pilot', 'portrait_pilot', INTRO_LINES, () => {
            this.story.introDone = true;
            this.objectiveBanner.show('Find a Professor on Level 1');
            this._playerLocked = false;
          });
        });
      });
    });
  }

  /** Space/Enter — the ONE place both "close/advance an open dialogue" and
   *  "open a new one" are decided, so a single keypress can't do both (see
   *  dialogue.js for why DialogueBox itself doesn't bind these keys). */
  handleInteractKey() {
    if (this._formOpen) return;
    if (this.dialogue.isOpen) { this.dialogue.advance(); return; }
    const target = this._nearestInteractable;
    if (target) target.onInteract();
  }

  // ---------------------------------------------------------------------
  // Level construction
  // ---------------------------------------------------------------------

  /** shared: build a floor fill + a 4-side wall/railing border out of a small
   *  repeating tile, return { bounds, colliders (wall bands) } */
  buildRoomShell(objects, w, h, floorKey, wallKey, wallColor) {
    const floor = this.add.tileSprite(w / 2, h / 2, w, h, floorKey).setOrigin(0.5).setDepth(-100000);
    objects.push(floor);

    const bands = [
      { x: w / 2, y: WALL_T / 2, w, h: WALL_T },                     // north
      { x: w / 2, y: h - WALL_T / 2, w, h: WALL_T },                 // south
      { x: WALL_T / 2, y: h / 2, w: WALL_T, h },                     // west
      { x: w - WALL_T / 2, y: h / 2, w: WALL_T, h },                 // east
    ];
    const colliders = [];
    for (const b of bands) {
      // tile_fence's art is a horizontal post+bars segment (64x32) — on the
      // west/east bands (narrow, TALL) a plain TileSprite would tile it
      // along the wrong axis and crop the posts. Build those two bands
      // sideways (swapped w/h) and rotate 90° so the fence pattern runs
      // vertically instead; the on-screen footprint (and collider) is
      // unaffected. Other wall textures (tile_wall, tile_grating) are
      // orientation-agnostic panel/grate patterns, so leave them alone.
      const vertical = wallKey === 'tile_fence' && b.h > b.w;
      const ts = vertical
        ? this.add.tileSprite(b.x, b.y, b.h, b.w, wallKey).setOrigin(0.5).setAngle(90).setDepth(-99000)
        : this.add.tileSprite(b.x, b.y, b.w, b.h, wallKey).setOrigin(0.5).setDepth(-99000);
      objects.push(ts);
      const rect = new Phaser.Geom.Rectangle(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
      rect.name = wallColor;
      colliders.push(rect);
    }
    return { bounds: { x: 0, y: 0, width: w, height: h }, colliders };
  }

  /** a short repeating-texture barrier band (used for the mecha's railing
   *  fence and the maze's interior divider walls) — same idea as a wall
   *  band in buildRoomShell, just not tied to a room edge. Always solid.
   *  Both the fence and the new divider-wall art are horizontal post/panel
   *  segments (wide, short) — auto-rotate 90° when h>w (a vertical wall
   *  segment) so the pattern still runs the right way, same fix as
   *  buildRoomShell's west/east bands.
   *  `visualH` (horizontal segments only) renders the sprite TALLER than
   *  the collider, centered on the same line — the divider walls use this
   *  to look like an imposing wall instead of a painted curb, without the
   *  footprint (or the doorway gaps measured against it) changing at all. */
  placeBarrier(objects, colliders, textureKey, x, y, w, h, name, visualH = null) {
    const vertical = h > w;
    const vh = (!vertical && visualH) ? visualH : h;
    const ts = vertical
      ? this.add.tileSprite(x, y, h, w, textureKey).setOrigin(0.5).setAngle(90).setDepth(y)
      : this.add.tileSprite(x, y, w, vh, textureKey).setOrigin(0.5).setDepth(y);
    objects.push(ts);
    const rect = new Phaser.Geom.Rectangle(x - w / 2, y - h / 2, w, h);
    rect.name = name;
    colliders.push(rect);
    return ts;
  }

  /** an overhead gantry-truss band — purely decorative (no collider, the
   *  player walks under it just like they'd walk under real ceiling
   *  rigging). Same auto-rotate-for-vertical-runs trick as placeBarrier,
   *  but rendered at a fixed very-high depth so it always draws in FRONT
   *  of everything below it (walls, the mecha, props) — it reads as
   *  mounted above the scene, not as floor-level dressing.
   *  `scale` enlarges the truss's own cross-section pattern (via tile
   *  scale, not just a bigger target box) so a 2x band reads as a
   *  chunkier beam, not the same-size pattern repeated more times. w/h
   *  are the already-doubled target thickness/span the caller wants. */
  placeTrussBand(objects, x, y, w, h, scale = 1) {
    const vertical = h > w;
    const ts = vertical
      ? this.add.tileSprite(x, y, h, w, 'truss').setOrigin(0.5).setAngle(90).setDepth(999000)
      : this.add.tileSprite(x, y, w, h, 'truss').setOrigin(0.5).setDepth(999000);
    ts.setTileScale(scale, scale);
    objects.push(ts);
    return ts;
  }

  /** a red rotary hazard beacon: a static lamp-housing sprite plus a
   *  translucent red light wedge that spins continuously around it (a
   *  Graphics sector, tweened through 360°) and the lamp itself pulses
   *  alpha in time — reads as an active rotating warning light without
   *  needing a multi-frame animated sprite. Purely decorative, no
   *  collider (small enough, and placed in open floor, that it doesn't
   *  need to block the player). */
  placeRotaryBeacon(objects, x, y) {
    const lamp = this.add.image(x, y, 'beacon_lamp').setOrigin(0.5, 0.75).setDepth(y);
    objects.push(lamp);

    const beam = this.add.graphics().setPosition(x, y - 10).setDepth(y + 1);
    beam.fillStyle(0xff2020, 0.4);
    beam.slice(0, 0, 42, Phaser.Math.DegToRad(-18), Phaser.Math.DegToRad(18), false);
    beam.fillPath();
    objects.push(beam);

    this.tweens.add({ targets: beam, angle: 360, duration: 1400, repeat: -1, ease: 'Linear' });
    this.tweens.add({ targets: lamp, alpha: { from: 0.55, to: 1 }, duration: 450, yoyo: true, repeat: -1 });

    return { lamp, beam };
  }

  /** place a prop image at (x,y) with the given origin; if solid, add a
   *  collider rect anchored the SAME way as the sprite: originY <= 0.2 is a
   *  top-anchored sprite (image hangs BELOW y, e.g. the mecha against the
   *  back wall) so the box starts at y and grows down; anything else is
   *  treated as bottom/feet-anchored (the usual prop convention) so the box
   *  ends at y and grows up. Getting this backwards silently produces a
   *  "solid" collider that floats off the artwork.
   *  `scale` enlarges the sprite; cw/ch are given in NATIVE (pre-scale) px
   *  and are scaled up internally so the collider tracks the art. */
  placeProp(objects, colliders, key, x, y, { originX = 0.5, originY = 0.85, solid = false, cw = null, ch = null, depthBias = 0, scale = 1 } = {}) {
    const spr = this.add.image(x, y, key).setOrigin(originX, originY).setScale(scale).setDepth(y + depthBias);
    objects.push(spr);
    if (solid) {
      const tex = this.textures.get(key).getSourceImage();
      const w = (cw ?? tex.width * 0.8) * scale;
      const h = (ch ?? tex.height * 0.35) * scale;
      const topAnchored = originY <= 0.2;
      const rectY = topAnchored ? y : y - h;
      const rect = new Phaser.Geom.Rectangle(x - w / 2, rectY, w, h);
      rect.name = key;
      colliders.push(rect);
    }
    return spr;
  }

  buildLevel1() {
    const objects = [];
    const { bounds, colliders } = this.buildRoomShell(objects, L1.w, L1.h, 'tile_floor', 'tile_wall', 'wall');

    // ---- a soft ground shadow under the mecha's feet — same flat,
    // semi-transparent-ellipse convention as the player/NPC shadows, just
    // scaled up to match the mecha. Depth sits just above the floor but
    // below the mecha sprite itself (which is drawn at depth 0 further
    // down), so it reads as cast onto the floor under the legs rather than
    // floating on top of them. ----
    const mechaShadow = this.add.ellipse(L1.mechaX, 183, 225, 46, 0x000000, 0.45).setDepth(-1);
    objects.push(mechaShadow);

    // ---- centerpiece: legs/lower body pushed all the way to the true top
    // of the map (y=0), not just flush with the wall's inner face — it
    // now overlaps/renders in front of the north wall band instead of
    // sitting just behind it, reading as "maxed out against the top"
    // rather than merely adjacent to it. Collision box (cw/ch) matches
    // the sprite's actual visible silhouette (verified against the crop's
    // bbox, not just the canvas size). ----
    this.placeProp(objects, colliders, 'mecha_lower', L1.mechaX, 0, {
      originX: 0.5, originY: 0, solid: true, cw: 165, ch: 150, scale: MECHA_SCALE,
    });
    // mecha's collision now spans 0 to 150*MECHA_SCALE
    const L1_MECHA_FOOT_Y = 150 * MECHA_SCALE;
    const L1_BARRIER_Y = L1_MECHA_FOOT_Y + 8;

    // ---- railing barrier sitting right at the base of the mecha's feet
    // (flush against its own collision box, not floating below it) — the
    // player is blocked here first, but the mecha's own collider backs it
    // up immediately behind. NOT a tile_divider — this is the
    // yellow-striped tile_fence, deliberately left at its normal height
    // (only the plain concrete dividers got the "taller" treatment) ----
    this.placeBarrier(
      objects, colliders, 'tile_fence',
      L1.mechaX, L1_BARRIER_Y, 220, 16, 'mecha_railing',
    );

    // ---- floor stencil: "ENGINE44", stretched to the mecha's own visible
    // width, painted on the open floor just south of the barrier. Purely
    // decorative (no collider) — depth just above the base floor tile so
    // it reads as painted ON the floor, under every prop/wall/character. ----
    {
      const label = this.add.text(L1.mechaX, L1_BARRIER_Y + 22, 'ENGINE44', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '40px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      label.setDisplaySize(220, label.height * (220 / label.width)); // ~ the mecha's visible width
      objects.push(label);
    }

    // ---- red rotary hazard beacons flanking the mecha's legs, just south
    // of the barrier in the open floor (clear of both the barrier's own
    // collision and the workshop/storage rooms). ----
    this.placeRotaryBeacon(objects, 200, 225);
    this.placeRotaryBeacon(objects, 388, 225);

    // ---- overhead gantry truss: now a full rectangular frame around all
    // four edges of the map (top/left/right/bottom), not just the top-left
    // corner brace from before. Purely visual, drawn in front of
    // everything else. 2x scale — both the beam's thickness (64 instead
    // of 32) and its own cross-braced pattern (via tileScale) are
    // doubled, so it reads as a genuinely chunkier structure, not the
    // same beam just repeated more times. ----
    this.placeTrussBand(objects, L1.w / 2, 32, L1.w, 64, 2);        // top
    this.placeTrussBand(objects, 32, L1.h / 2, 64, L1.h, 2);        // left
    this.placeTrussBand(objects, L1.w - 32, L1.h / 2, 64, L1.h, 2); // right
    this.placeTrussBand(objects, L1.w / 2, L1.h - 32, L1.w, 64, 2); // bottom

    // ======================================================================
    // FRESH LAYOUT PASS — rebuilt from scratch around a reference concept:
    // mecha bay anchoring the top-center, a painted path running from
    // spawn straight up to it with a fork partway, and two mirrored side
    // rooms (workshop / storage) sharing the same footprint on a common
    // grid, with a third smaller room (briefing) tucked under workshop.
    // No maze walls this time — each room has just the wall(s) it needs
    // to read as a room, everything else is open floor.
    //
    // Grid, in x: workshop 32-184, mecha bay 184-404 (matches the
    // barrier's own width, so no separate divider wall is needed between
    // either side room and the mecha — its own collision is the
    // boundary), storage 404-556. Both side rooms share y32-190 (top row,
    // flush with the north wall). Briefing sits directly under workshop,
    // same x-span, y245-346.
    // ======================================================================
    const ROW_TOP = WALL_T;            // 32 — shared north edge for workshop/storage
    const ROW_BOTTOM = 190;            // shared south wall for workshop/storage
    const SIDE_W = 152;                // workshop/storage interior width — kept
                                        // identical for the "mirrored, symmetrical
                                        // size" ask
    const WS_L = WALL_T, WS_R = WALL_T + SIDE_W;         // workshop: 32-184
    const ST_R = L1.w - WALL_T, ST_L = ST_R - SIDE_W;    // storage: 404-556, mirrored
    const DOOR_L = 100, DOOR_R = 160;  // shared doorway x-span — used for BOTH
                                        // workshop's south wall and briefing's north
                                        // wall so the path between them runs straight
    const BRIEF_TOP = 245, BRIEF_BOTTOM = L1.h - WALL_T; // 245-346, under workshop

    const eDoorL = L1.w - DOOR_R, eDoorR = L1.w - DOOR_L; // storage's mirrored doorway

    // ======================================================================
    // ZONE — workshop (x32-184, y32-190): tool rack, workbench, supply
    // cart, two terminals. Only a south wall — the mecha's own collision
    // is already the boundary on the east side, so no divider needed
    // there (one caused a real connectivity bug last round; simplest fix
    // is to not add a wall the mecha already provides).
    // ======================================================================
    this.placeBarrier(objects, colliders, 'tile_wall', (WS_L + DOOR_L) / 2, ROW_BOTTOM, DOOR_L - WS_L, 16, 'wall');
    this.placeBarrier(objects, colliders, 'tile_wall', (DOOR_R + WS_R) / 2, ROW_BOTTOM, WS_R - DOOR_R, 16, 'wall');
    this.placeProp(objects, colliders, 'tool_rack', 55, 80, { originY: 0.9, solid: true, cw: 30, ch: 18 });
    this.placeProp(objects, colliders, 'workbench', 100, 80, { solid: true, cw: 50, ch: 24 });
    this.placeProp(objects, colliders, 'supply_cart', 155, 80, { solid: true, cw: 44, ch: 24 });
    this.placeProp(objects, colliders, 'terminal', 60, 130, { solid: true, cw: 26, ch: 22 });
    this.placeProp(objects, colliders, 'terminal', 125, 130, { solid: true, cw: 26, ch: 22 });
    this.placeProp(objects, colliders, 'warning_poster', 150, WALL_T + 8, { originY: 0.1, solid: false });

    // ======================================================================
    // ZONE — storage (x404-556, y32-190): mirror image of workshop —
    // crates + locker + shelving in place of tools, same footprint,
    // same wall/doorway split reflected around the mecha's centerline.
    // ======================================================================
    this.placeBarrier(objects, colliders, 'tile_wall', (ST_L + eDoorL) / 2, ROW_BOTTOM, eDoorL - ST_L, 16, 'wall');
    this.placeBarrier(objects, colliders, 'tile_wall', (eDoorR + ST_R) / 2, ROW_BOTTOM, ST_R - eDoorR, 16, 'wall');
    // top-right corner (x>500) kept clear of props — that's where the
    // ladder up to L2 lives now, see below
    this.placeProp(objects, colliders, 'crate_stack_b', 452, 80, { solid: true, cw: 24, ch: 20 });
    this.placeProp(objects, colliders, 'crate_stack_a', 420, 80, { solid: true, cw: 24, ch: 20 });
    this.placeProp(objects, colliders, 'storage_locker', 420, 130, { solid: true, cw: 24, ch: 36 });
    this.placeProp(objects, colliders, 'shelving_unit', 465, 130, { solid: true, cw: 34, ch: 26 });
    this.placeProp(objects, colliders, 'fire_extinguisher', 405, WALL_T + 8, { originY: 0.1, solid: false });

    // ======================================================================
    // ZONE — briefing (x32-184, y245-346): the third, smaller room, tucked
    // directly under workshop on the same x-grid. Only a north wall, with
    // the same doorway x-span as workshop's south wall above it so the
    // path between them runs in a straight line. Furniture kept well
    // south of the doorway (y>=300) — last round's doorway-sealing bug
    // came from placing furniture too close beneath a wall's padding.
    // ======================================================================
    this.placeBarrier(objects, colliders, 'tile_wall', (WS_L + DOOR_L) / 2, BRIEF_TOP, DOOR_L - WS_L, 16, 'wall');
    this.placeBarrier(objects, colliders, 'tile_wall', (DOOR_R + WS_R) / 2, BRIEF_TOP, WS_R - DOOR_R, 16, 'wall');

    // ---- the short doorway-flanking wall strips (workshop's south wall,
    // storage's south wall, briefing's north wall) were bare tile_wall
    // texture with nothing on them — read as empty debug hit-boxes with no
    // prop to justify them. A safe centered on each one fills that out. ----
    this.placeProp(objects, colliders, 'safe', (WS_L + DOOR_L) / 2, ROW_BOTTOM + 8, { solid: false });
    this.placeProp(objects, colliders, 'safe', (DOOR_R + WS_R) / 2, ROW_BOTTOM + 8, { solid: false });
    this.placeProp(objects, colliders, 'safe', (ST_L + eDoorL) / 2, ROW_BOTTOM + 8, { solid: false });
    this.placeProp(objects, colliders, 'safe', (eDoorR + ST_R) / 2, ROW_BOTTOM + 8, { solid: false });
    this.placeProp(objects, colliders, 'safe', (WS_L + DOOR_L) / 2, BRIEF_TOP + 8, { solid: false });
    this.placeProp(objects, colliders, 'safe', (DOOR_R + WS_R) / 2, BRIEF_TOP + 8, { solid: false });

    this.placeProp(objects, colliders, 'filing_cabinet', 65, 300, { solid: true, cw: 22, ch: 20 });
    this.placeProp(objects, colliders, 'desk', 105, 300, { solid: true, cw: 36, ch: 22 });
    this.placeProp(objects, colliders, 'office_chair', 105, 318, { solid: true, cw: 20, ch: 18 });
    this.placeProp(objects, colliders, 'bookshelf', 150, 300, { solid: true, cw: 30, ch: 22 });
    this.placeProp(objects, colliders, 'side_table', 65, 322, { solid: true, cw: 20, ch: 20 });
    this.placeProp(objects, colliders, 'potted_plant', 150, 322, { solid: true, cw: 18, ch: 18 });

    // ---- ladder-up connector: moved into storage's top-right corner,
    // as far up and to the right as the room allows. Dropped the earlier
    // 2-sprite vertical stack here — at native 64px tall each, a stacked
    // pair would run 38px past the top of the map at this height (there's
    // only ~58px of room between the wall and where props start); a
    // single sprite already reaches up into the wall band slightly,
    // reading as "leading up into the ceiling toward L2" without
    // clipping off-screen. ----
    // no longer solid — the ladder used to block the player itself, on top
    // of the separate trigger zone doing the actual level-transition
    // detection; removing the hit-box means walking up to/through the
    // ladder sprite is unobstructed, the trigger alone handles the climb.
    const upLadder = this.placeProp(objects, colliders, 'ladder', L1.upLadder.x, L1.upLadder.y, {
      originY: 1, solid: false,
    });

    // ---- floor stencil: "LEVEL 2 ^" painted just below the ladder, same
    // treatment as the ENGINE44 stencil (no collider, low depth, 70%
    // opacity white). Marks the ladder as the way up without needing a
    // separate UI callout. ----
    {
      const label = this.add.text(L1.upLadder.x - 20, L1.upLadder.y + 30, 'LEVEL 2 ↑', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '14px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      objects.push(label);
    }
    // trigger zone enlarged 20% (56x50 -> 67.2x60) on the same center point
    // as before, so it's easier to walk into without having moved where it
    // sits relative to the ladder prop.
    const upLadderTrigger = new Phaser.Geom.Rectangle(
      L1.upLadder.x - 33.6, L1.upLadder.y - 59, 67.2, 60,
    );

    // ---- down-hatch connector: the way DOWN to Level 0 (control room),
    // bottom-right open floor. A dark "hole" in the floor with just the
    // ladder's top poking out of it — same visual recipe as the old L3
    // entrance had, just relocated here now that the control room sits
    // below L1 instead of above L2. Non-solid, same "trigger alone does
    // the work" treatment as the up-ladder above. ----
    const downHoleShadow = this.add.ellipse(L1.downLadder.x, L1.downLadder.y, 46, 30, 0x000000, 0.85)
      .setDepth(L1.downLadder.y - 2);
    objects.push(downHoleShadow);
    const downLadder = this.placeProp(objects, colliders, 'ladder', L1.downLadder.x, L1.downLadder.y, {
      originY: 1, solid: false,
    });
    {
      const label = this.add.text(L1.downLadder.x - 20, L1.downLadder.y + 20, 'LEVEL 0 ↓', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '14px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      objects.push(label);
    }
    const downLadderTrigger = new Phaser.Geom.Rectangle(
      L1.downLadder.x - 28, L1.downLadder.y - 54, 56, 50,
    );

    return {
      objects, bounds, colliders, upLadder, upLadderTrigger, upLadderFired: false,
      downLadder, downLadderTrigger, downLadderFired: false,
      barrierY: L1_BARRIER_Y, wanderers: [], interactables: [],
    };
  }

  buildLevel2() {
    const objects = [];
    const colliders = [];
    const bounds = { x: 0, y: 0, width: L2.w, height: L2.h };

    // ======================================================================
    // ZONE — mecha bay (north of the full-width barrier): no floor tile,
    // no side walls, no cutout, no monitors — just the user-supplied
    // background image, with the mecha standing in front of it. Nothing
    // here is reachable anyway (the barrier below is the real boundary),
    // so there's no shell/collision needed for this zone at all.
    // ======================================================================
    // background image: anchored at the top-left corner, stretched to
    // fill the bay's full width and (since the source art's ~5:1 aspect
    // ratio already matches L2.w:L2.barrierY almost exactly) its height
    // down to the barrier line. Depth far behind everything else in the
    // scene — including the catwalk's own floor tile — so it only shows
    // through where nothing else is drawn over it.
    const mechaBayBg = this.add.image(0, 0, 'mecha_bay_bg').setOrigin(0, 0).setDepth(-999999);
    mechaBayBg.setDisplaySize(L2.w, L2.barrierY);
    objects.push(mechaBayBg);

    // flush against the wall — same zero-gap treatment as L1's mecha_lower
    this.placeProp(objects, colliders, 'mecha_upper', L2_MECHA_X, WALL_T, {
      originX: 0.5, originY: 0, solid: true, cw: 164, ch: 120, scale: MECHA_SCALE,
    });

    // ---- red rotary hazard beacon to the right of the mecha, in the
    // blank bay area (no floor/collision there, purely decorative). ----
    this.placeRotaryBeacon(objects, 610, 110);

    // ---- full-width railing: the real barrier between the walkable
    // catwalk and the blank mecha bay above — sits flush at the base of
    // the mecha's feet (L2.barrierY is derived from that, not a fixed
    // guess), not floating south of it. Spans the entire interior width,
    // not just the strip in front of the mecha. ----
    this.placeBarrier(
      objects, colliders, 'tile_fence',
      L2.w / 2, L2.barrierY, L2.w - WALL_T * 2, 16, 'mecha_railing',
    );

    // ---- catwalk shell: floor + south/west/east walls, confined to the
    // walkable strip below the barrier — the blank mecha bay above has no
    // shell of its own now. ----
    const catwalkH = L2.h - L2.barrierY;
    const catwalkCY = L2.barrierY + catwalkH / 2;
    const floor = this.add.tileSprite(L2.w / 2, catwalkCY, L2.w, catwalkH, 'tile_grating')
      .setOrigin(0.5).setDepth(-100000);
    objects.push(floor);
    const wallBand = (x, y, w, h) => {
      const vertical = h > w;
      const ts = vertical
        ? this.add.tileSprite(x, y, h, w, 'tile_fence').setOrigin(0.5).setAngle(90).setDepth(-99000)
        : this.add.tileSprite(x, y, w, h, 'tile_fence').setOrigin(0.5).setDepth(-99000);
      objects.push(ts);
      const rect = new Phaser.Geom.Rectangle(x - w / 2, y - h / 2, w, h);
      rect.name = 'railing';
      colliders.push(rect);
    };
    wallBand(L2.w / 2, L2.h - WALL_T / 2, L2.w, WALL_T);            // south
    wallBand(WALL_T / 2, catwalkCY, WALL_T, catwalkH);               // west
    wallBand(L2.w - WALL_T / 2, catwalkCY, WALL_T, catwalkH);        // east

    // ======================================================================
    // ZONE — diagnostic bank (south of the barrier, centered on the mecha):
    // the three terminals lined up in a row, directly facing the mecha —
    // a monitoring station, not props scattered around the floor.
    // ======================================================================
    this.placeProp(objects, colliders, 'terminal', 390, 250, { solid: true, cw: 28, ch: 24 });
    this.placeProp(objects, colliders, 'terminal', 490, 250, { solid: true, cw: 28, ch: 24 });
    this.placeProp(objects, colliders, 'terminal', 590, 250, { solid: true, cw: 28, ch: 24 });

    // ======================================================================
    // ZONE — storage nook (west end of the catwalk, along the south wall):
    // filing cabinet + storage bin. The shelving unit that used to sit
    // here (x90) was removed outright — its footprint overlapped the
    // "LEVEL 3 v" floor stencil by the down-hatch (x57,y272, west wall),
    // partly covering the "3". No replacement needed; two items still
    // read fine as a nook.
    // ======================================================================
    this.placeProp(objects, colliders, 'filing_cabinet', 138, 300, { solid: true, cw: 24, ch: 22 });
    this.placeProp(objects, colliders, 'storage_bin', 180, 300, { solid: true, cw: 24, ch: 22 });

    // ---- maintenance nook: now empty open floor — the ladder that used
    // to sit here was purely decorative and has been moved to the west
    // wall as the real connector down to Level 3 (see below); the steel
    // drum and the cable spool that used to flank it were both removed
    // outright, they were narrowing the walkway enough to block the path.

    // -- alcove divider: a short plain-steel stub wall closes off the
    // storage/maintenance nook from the terminal bank, with an opening at
    // the south end (near the south railing) to walk in from. The
    // walkable band here is only ~80px deep, so this is a partial screen
    // rather than a fully enclosed room — enough to read as its own
    // alcove without choking the corridor. ----
    this.placeBarrier(objects, colliders, 'tile_divider', 360, 243, 16, 34, 'divider');
    this.placeProp(objects, colliders, 'wall_endcap', 360, 260, { solid: false });

    // ======================================================================
    // ZONE — east wall dressing (between the terminal bank and the ladder
    // connector): banner + whiteboard, both non-solid, against the wall.
    // ======================================================================
    this.placeProp(objects, colliders, 'banner', 760, 304, { originY: 1, solid: false });
    this.placeProp(objects, colliders, 'whiteboard', 810, 304, { originY: 1, solid: false });

    // ---- ladder connector: the way back down ----
    const ladder = this.placeProp(objects, colliders, 'ladder', L2.ladder.x, L2.ladder.y, {
      originY: 1, solid: true, cw: 26, ch: 16,
    });
    const ladderTrigger = new Phaser.Geom.Rectangle(
      L2.ladder.x - 30, L2.ladder.y - 60, 60, 56,
    );

    // ---- down-hatch connector: the way DOWN to Level 3 (commander room),
    // flush against the west wall at the catwalk's vertical middle. Same
    // dark "hole in the floor with the ladder's top poking out" treatment
    // as L1's own hatch down to L0. Non-solid — the trigger alone handles
    // the climb. ----
    const downHoleShadow = this.add.ellipse(L2.downLadder.x, L2.downLadder.y, 46, 30, 0x000000, 0.85)
      .setDepth(L2.downLadder.y - 2);
    objects.push(downHoleShadow);
    const downLadder = this.placeProp(objects, colliders, 'ladder', L2.downLadder.x, L2.downLadder.y, {
      originY: 1, solid: false,
    });
    {
      const label = this.add.text(L2.downLadder.x + 2, L2.downLadder.y + 20, 'LEVEL 3 ↓', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '13px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      objects.push(label);
    }
    const downLadderTrigger = new Phaser.Geom.Rectangle(
      L2.downLadder.x - 28, L2.downLadder.y - 54, 56, 50,
    );

    return {
      objects, bounds, colliders, ladder, ladderTrigger, ladderFired: false,
      downLadder, downLadderTrigger, downLadderFired: false, wanderers: [], interactables: [],
    };
  }

  buildLevel0() {
    const objects = [];
    const { bounds, colliders } = this.buildRoomShell(objects, L0.w, L0.h, 'tile_floor', 'tile_wall', 'wall');

    // ---- hit-block sealing off the top half of the room (from the north
    // wall down to the vertical midline) — the window/console band reads
    // as a raised, walled-off deck the player can look at but not walk
    // into, rather than open floor. Collision only, no new art: the hex
    // frame + monitors already dress this area visually. ----
    colliders.push(new Phaser.Geom.Rectangle(
      WALL_T, WALL_T, L0.w - WALL_T * 2, L0.h / 2 - WALL_T,
    ));
    colliders[colliders.length - 1].name = 'block';

    // ---- large hexagonal viewport frame set into the north wall — the
    // user's own space image is baked directly into the frame texture's
    // interior now (composited in image-editing, not a separate game
    // object), so this one sprite is both the frame AND the view through
    // it. Scaled up slightly alongside the room's own 30% size bump —
    // reads as "a large window on the wall", not "the window is the whole
    // room". Top-anchored flush with the wall, same "pushed to the very
    // top" convention as the mecha on L1/L2. ----
    this.placeProp(objects, colliders, 'hex_frame', L0.w / 2, 0, {
      originX: 0.5, originY: 0, solid: false, scale: 0.65,
    });

    // ---- a pair of small wall monitors flanking the frame, just under
    // the top wall — a hint of the console-bank look from the reference
    // image without needing the floor space a full terminal row would
    // cost in a room this size. ----
    this.placeProp(objects, colliders, 'wall_monitor_a', 66, WALL_T + 4, { originY: 0.1, solid: false });
    this.placeProp(objects, colliders, 'wall_monitor_b', L0.w - 66, WALL_T + 4, { originY: 0.1, solid: false });

    // ---- centerpiece: a round holographic command table (star-system
    // radar display, two chairs baked into the same sprite) — the focal
    // point of the reference image, standing in for the wall console row
    // + separate central table the reference shows (both wouldn't fit in
    // the old half-size room, so this single piece carried the "control
    // room command center" read — kept front-and-center now that there's
    // more floor to work with). ----
    this.placeProp(objects, colliders, 'holo_table', 105, 140, {
      solid: true, cw: 70, ch: 32,
    });

    // ---- up-ladder connector: the way back up to L1, tucked in the
    // bottom-right corner. A plain ladder, non-solid — same "trigger
    // alone does the work" treatment as L1's own up-ladder to L2 (no
    // floor-hole here; that visual belongs on L1's side, looking DOWN
    // into this room, not in here looking UP). ----
    const upLadder = this.placeProp(objects, colliders, 'ladder', L0.upLadder.x, L0.upLadder.y, {
      originY: 1, solid: false,
    });
    {
      const label = this.add.text(L0.upLadder.x - 18, L0.upLadder.y + 16, 'LEVEL 1 ↑', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      objects.push(label);
    }
    const upLadderTrigger = new Phaser.Geom.Rectangle(
      L0.upLadder.x - 26, L0.upLadder.y - 50, 52, 46,
    );

    return { objects, bounds, colliders, upLadder, upLadderTrigger, upLadderFired: false, wanderers: [], interactables: [] };
  }

  buildLevel3() {
    const objects = [];
    const { bounds, colliders } = this.buildRoomShell(objects, L3.w, L3.h, 'tile_floor', 'tile_wall', 'wall');

    // ---- hit-block sealing off the top half of the room (from the north
    // wall down to the vertical midline) — same treatment as L0's window
    // band: the viewport + console row reads as a raised, walled-off deck
    // the player can look at but not walk into. Collision only, no new
    // art needed. ----
    colliders.push(new Phaser.Geom.Rectangle(
      WALL_T, WALL_T, L3.w - WALL_T * 2, L3.h / 2 - WALL_T,
    ));
    colliders[colliders.length - 1].name = 'block';

    // ---- wide panoramic viewport spanning most of the north wall — same
    // "user's space image baked into the frame texture" trick as L0's hex
    // window. Top-anchored flush with the wall. ----
    this.placeProp(objects, colliders, 'bridge_window', L3.w / 2, 0, {
      originX: 0.5, originY: 0, solid: false,
    });

    // ---- the command console row: captain's chair dead-center, flanked
    // by two terminal-and-chair workstations on each side — the bridge
    // crew stations from the reference image. ----
    const consoleXs = [90, 160, 300, 370];
    for (const x of consoleXs) {
      this.placeProp(objects, colliders, 'terminal', x, 110, { solid: true, cw: 28, ch: 24 });
      this.placeProp(objects, colliders, 'office_chair', x, 128, { solid: true, cw: 20, ch: 18 });
    }
    this.placeProp(objects, colliders, 'captain_chair', L3.w / 2, 122, {
      solid: true, cw: 26, ch: 24, scale: 1.15,
    });

    // ---- potted plants in the corners either side of the window, same
    // touch as the reference image. ----
    this.placeProp(objects, colliders, 'potted_plant', 50, 60, { solid: true, cw: 18, ch: 18 });
    this.placeProp(objects, colliders, 'potted_plant', L3.w - 50, 60, { solid: true, cw: 18, ch: 18 });

    // ---- tactical holo-table further south — the bridge's main plotting
    // table, same asset as L0's command table, given more room to breathe
    // here. ----
    this.placeProp(objects, colliders, 'holo_table', L3.w / 2, 210, {
      solid: true, cw: 90, ch: 40,
    });

    // ---- up-ladder connector: the way back up to L2, west side, clear of
    // the console row and the table. A plain ladder, non-solid — same
    // "trigger alone does the work" treatment as L0's own up-ladder to L1
    // (no floor-hole here; that visual belongs on L2's side, looking DOWN
    // into this room). ----
    const upLadder = this.placeProp(objects, colliders, 'ladder', L3.upLadder.x, L3.upLadder.y, {
      originY: 1, solid: false,
    });
    {
      const label = this.add.text(L3.upLadder.x + 2, L3.upLadder.y + 16, 'LEVEL 2 ↑', {
        fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
      }).setOrigin(0.5).setAlpha(0.7).setDepth(-99998);
      objects.push(label);
    }
    const upLadderTrigger = new Phaser.Geom.Rectangle(
      L3.upLadder.x - 26, L3.upLadder.y - 50, 52, 46,
    );

    return { objects, bounds, colliders, upLadder, upLadderTrigger, upLadderFired: false, wanderers: [], interactables: [] };
  }

  /** the ending corridor — see the DOCK constant above for why this has no
   *  ladder/hatch fields. Built like the other levels (objects/colliders
   *  arrays, wanderers/interactables), just reached via goToDock() instead
   *  of a walk-into trigger. */
  buildDock() {
    const objects = [];
    const colliders = [];
    const bounds = { x: 0, y: 0, width: DOCK.w, height: DOCK.h };

    // ---- backdrop: the same user-supplied mecha-bay image used behind
    // L2's mecha (see buildLevel2's mechaBayBg), here uniformly scaled so
    // its native height fills the corridor's own height and tiled
    // horizontally to run the full length — exactly the "reuse + extend
    // horizontally" the brief asked for. Depth far behind everything,
    // including the floor strip below, so it only shows through the
    // top/bottom margins the floor doesn't cover — reads as the
    // corridor's wall/ceiling dressing (it's already got hanging
    // cables/pipes/lights at the top of the source art). ----
    const bgTex = this.textures.get('mecha_bay_bg').getSourceImage();
    const bgScale = DOCK.h / bgTex.height;
    const bg = this.add.tileSprite(DOCK.w / 2, DOCK.h / 2, DOCK.w, DOCK.h, 'mecha_bay_bg')
      .setOrigin(0.5).setDepth(-999999);
    bg.setTileScale(bgScale, bgScale);
    objects.push(bg);

    // ---- floor: a steel tile strip — same texture as L1's ground floor —
    // spanning only the walkway band (DOCK.walkwayTop..walkwayBottom), not
    // the full corridor height. The background shows through above and
    // below it as unreachable wall/ceiling dressing (blocked off below),
    // so the floor strip itself is the visual read for "this is where you
    // walk". ----
    const floor = this.add.tileSprite(DOCK.w / 2, (DOCK.walkwayTop + DOCK.walkwayBottom) / 2, DOCK.w, WALKWAY_H, 'tile_floor')
      .setOrigin(0.5).setDepth(-100000);
    objects.push(floor);

    // ---- seal the walkway to just that band: block colliders above and
    // below it, same "invisible collision, no new art" trick L0/L3 use for
    // their sealed-off console decks. Without this, resolveMove()'s own
    // generic WALL_T-inset bounds clamp would let the player roam the
    // entire (now much taller, camera-fill-driven) DOCK.h instead of just
    // the narrow single-file band the brief asked for. ----
    const topBlock = new Phaser.Geom.Rectangle(0, 0, DOCK.w, DOCK.walkwayTop);
    topBlock.name = 'block';
    colliders.push(topBlock);
    const bottomBlock = new Phaser.Geom.Rectangle(0, DOCK.walkwayBottom, DOCK.w, DOCK.h - DOCK.walkwayBottom);
    bottomBlock.name = 'block';
    colliders.push(bottomBlock);

    // ---- red rotary hazard beacons the full length of the corridor, up
    // in the background margins above/below the walkway (alternating edge)
    // — "long warning-lit dock" the whole way down, not just a beacon or
    // two near the ends. ----
    const BEACON_COUNT = 7;
    const BEACON_MARGIN = 120;
    for (let i = 0; i < BEACON_COUNT; i++) {
      const x = BEACON_MARGIN + (i * (DOCK.w - BEACON_MARGIN * 2)) / (BEACON_COUNT - 1);
      const y = i % 2 === 0 ? 40 : DOCK.h - 40;
      this.placeRotaryBeacon(objects, x, y);
    }

    return { objects, bounds, colliders, wanderers: [], interactables: [] };
  }

  // ---------------------------------------------------------------------
  // NPCs — wandering Professor/Mechanic + stationary welding Welder
  // ---------------------------------------------------------------------

  /** a small footprint rect for an NPC, feet-anchored like other props'
   *  colliders — pushed into the SAME colliders array the player's own
   *  resolveMove already reads, so "player can't walk through NPCs" falls
   *  out for free with no extra plumbing on the player side. */
  static npcCollider(x, y, w = 20, h = 14) {
    const rect = new Phaser.Geom.Rectangle(x - w / 2, y - h, w, h);
    rect.name = 'npc';
    return rect;
  }

  /** spawn one wandering NPC on Level 1: actor + collider + WanderController,
   *  registered into the target level's objects (for show/hide on level
   *  switch), colliders (so both the player and other wanderers collide
   *  with it) and wanderers (so update() drives its AI each frame). */
  spawnWanderer(level, prefix, x, y, speed, radius) {
    const actor = new NpcActor(this, prefix, x, y);
    level.objects.push(actor.sprite, actor.shadow);
    const collider = HangarScene.npcCollider(x, y);
    level.colliders.push(collider);
    const wander = new WanderController(actor, collider, { homeX: x, homeY: y, radius, speed });
    level.wanderers.push(wander);
    this.addInteractable(level, prefix, () => actor.x, () => actor.y);
  }

  /** register an NPC as talkable: an AskIndicator (pushed into the level's
   *  objects array so it hides/shows with the level itself) plus an entry
   *  in level.interactables that update() uses to find "nearest NPC in
   *  range". What talking to it actually SAYS is resolved fresh on every
   *  interaction via resolveNpcDialogue (story.js) — not fixed at
   *  registration time — so the same Professor gives different lines
   *  before/after each story gate without needing separate NPC instances.
   *  `ctx` carries anything resolveNpcDialogue needs beyond the prefix
   *  and level, e.g. `{ isWelderLegs: true }` for the one L1 welder beat
   *  3 is about, plus an optional `range` (interaction radius in px,
   *  defaults to 46 — see update()) for the rare NPC a solid prop keeps
   *  the player further back than usual. No-op if the prefix isn't in
   *  NPC_DIALOGUE at all. */
  addInteractable(level, prefix, getX, getY, ctx = {}) {
    if (!NPC_DIALOGUE[prefix]) return;
    const { range, ...dialogueCtx } = ctx;
    const levelId = level === this.level0 ? 'level0'
      : level === this.level1 ? 'level1'
        : level === this.level2 ? 'level2'
          : level === this.level3 ? 'level3' : 'dock';
    // NOTE: deliberately NOT added to this.uiObjects — that list is for
    // screen-fixed HUD (dialogue box, objective banner), rendered by the
    // static zoom-1 uiCamera. An AskIndicator tracks a NPC's WORLD
    // position, so it has to render through the same (scrolling, zoomed)
    // main camera the NPC itself does, or its on-screen position doesn't
    // match the NPC it's supposed to float above. See fix note in
    // dialogue.js's AskIndicator for the bug this was.
    const indicator = new AskIndicator(this);
    level.objects.push(indicator.container);
    level.interactables.push({
      getX, getY, indicator, range,
      isActive: () => true,
      onInteract: () => {
        const resolved = resolveNpcDialogue(this.story, prefix, {
          levelId, ...dialogueCtx, setObjective: (text) => this.objectiveBanner.show(text),
        });
        if (resolved) this.dialogue.open(resolved.name, resolved.portraitKey, resolved.lines, resolved.onClose);
      },
    });
  }

  populateNpcs() {
    // ---- Professor x2 — calm, open floor only (never inside the walled
    // workshop/briefing/storage rooms). Homes sit in the open corridor
    // south of the mecha bay; the wander radius plus per-target obstacle
    // rejection in WanderController keeps them out of the rooms even
    // though the radius circles technically graze their walls. ----
    this.spawnWanderer(this.level1, 'npc_professor', 250, 270, 30, 55);
    this.spawnWanderer(this.level1, 'npc_professor', 400, 280, 30, 55);

    // ---- Robot Mechanic x3 — brisker pace, wider range, drifting toward
    // the workshop and storage exteriors (still open floor, not inside). ----
    this.spawnWanderer(this.level1, 'npc_mechanic', 150, 250, 50, 85);
    this.spawnWanderer(this.level1, 'npc_mechanic', 300, 280, 50, 95);
    this.spawnWanderer(this.level1, 'npc_mechanic', 430, 260, 50, 85);

    // ---- Level 2 — one Professor + one Mechanic wandering the catwalk,
    // south of the barrier. Homes sit in the open stretch between the
    // maintenance nook and the east wall dressing, clear of the terminal
    // row, storage/maintenance props, and the ladder connector. ----
    this.spawnWanderer(this.level2, 'npc_professor', 550, 270, 30, 50);
    this.spawnWanderer(this.level2, 'npc_mechanic', 650, 285, 50, 65);

    // ---- Welder x2 — stationary work posts, welding loop only (no
    // idle/walk, no wander). Positioned INSIDE the mecha's own visible
    // silhouette (not just adjacent to it on the floor) — L1's welder sits
    // in the mecha_lower's left-leg area, L2's sits at the mecha_upper's
    // left-shoulder area. Both x/y are picked from the mecha sprites'
    // actual visible bbox (native crop bbox * MECHA_SCALE + placement),
    // not eyeballed against the canvas size. ----
    const w1 = new StationaryWelder(this, 260, 170); // L1 mecha_lower: visible x188.7-388.9, y0-189.8 — left leg, near the foot
    this.level1.objects.push(w1.sprite, w1.shadow);
    this.level1.colliders.push(HangarScene.npcCollider(w1.sprite.x, w1.sprite.y, 24, 16));
    // range widened from the default 46 — he's posted deep enough inside
    // the mecha_lower's own collider (left leg) that the player can never
    // walk closer than ~53px to him; measured the actual closest approach
    // in-game and set this comfortably past it.
    this.addInteractable(this.level1, 'npc_welder', () => w1.sprite.x, () => w1.sprite.y, { isWelderLegs: true, range: 62 });

    const w2 = new StationaryWelder(this, 440, 100); // L2 mecha_upper: visible x384.7-582.3, y43.7-188 — left shoulder
    this.level2.objects.push(w2.sprite, w2.shadow);
    this.level2.colliders.push(HangarScene.npcCollider(w2.sprite.x, w2.sprite.y, 24, 16));
    this.addInteractable(this.level2, 'npc_welder', () => w2.sprite.x, () => w2.sprite.y);

    // ---- Commander x1 — stationed in the Commander Room (L3), standing
    // post south of the tactical holo-table (the console row above is
    // sealed off by the top-half block, so this is the room's own open
    // floor, not a compromise spot). No WanderController — "stationed"
    // means fixed at his post, same idle-only treatment in spirit as the
    // welders, just without a working animation of his own to loop. ----
    const commander = new NpcActor(this, 'npc_commander', 320, 195);
    this.level3.objects.push(commander.sprite, commander.shadow);
    this.level3.colliders.push(HangarScene.npcCollider(commander.sprite.x, commander.sprite.y, 22, 16));
    this.addInteractable(this.level3, 'npc_commander', () => commander.sprite.x, () => commander.sprite.y);

    // ---- Operator x1 — stationed at the far (west) end of the Dock
    // corridor, facing east toward the direction the player arrives from.
    // Static post like the Commander, just facing a non-default direction
    // out of the gate (setMotionState right after construction, before
    // anything else can see her mid-turn). Her dialogue ends the current
    // story build (see resolveNpcDialogue's npc_operator branch), so the
    // onDockOperatorDone callback is the one thing wired through ctx here. ----
    const operator = new NpcActor(this, 'npc_operator', DOCK.operator.x, DOCK.operator.y);
    operator.setMotionState(false, 'right');
    this.dock.objects.push(operator.sprite, operator.shadow);
    this.dock.colliders.push(HangarScene.npcCollider(operator.sprite.x, operator.sprite.y, 22, 16));
    this.addInteractable(this.dock, 'npc_operator', () => operator.sprite.x, () => operator.sprite.y, {
      onDockOperatorDone: () => this.endStory(),
    });
  }

  static setLevelVisible(level, visible) {
    for (const obj of level.objects) obj.setVisible(visible);
  }

  // ---------------------------------------------------------------------
  // Transition (trigger zone + reposition — NOT a scene.start reload)
  // ---------------------------------------------------------------------

  goToLevel2() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] ladder -> Level 2 (catwalk)');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level1, false);
      HangarScene.setLevelVisible(this.level2, true);
      this.active = 'level2';
      this.colliders = this.level2.colliders;
      this.player.setPosition(L2.ladderArrival.x, L2.ladderArrival.y);
      this.setCameraBounds(this.level2.bounds);
      this.cameras.main.centerOn(L2.ladderArrival.x, L2.ladderArrival.y);
      // arrival is clear of L2's own ladderTrigger by design, but arm the
      // flag anyway for consistency with every other connector below —
      // harmless if already outside the zone, and one less thing to keep
      // in sync by hand if the geometry ever moves.
      this.level2.ladderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  goToLevel1() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] ladder -> Level 1 (ground floor)');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level2, false);
      HangarScene.setLevelVisible(this.level1, true);
      this.active = 'level1';
      this.colliders = this.level1.colliders;
      this.player.setPosition(L1.upLadderReturn.x, L1.upLadderReturn.y);
      this.setCameraBounds(this.level1.bounds);
      this.cameras.main.centerOn(L1.upLadderReturn.x, L1.upLadderReturn.y);
      // the arrival point sits INSIDE L1's own upLadderTrigger zone (a
      // ~15px "just off the ladder" offset, same convention used
      // everywhere, but this trigger's box reaches further than that) —
      // without this, update()'s very next trigger check would read
      // "inside, not fired yet" and immediately bounce back to L2.
      this.level1.upLadderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  goToLevel0() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] hatch -> Level 0 (control room)');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level1, false);
      HangarScene.setLevelVisible(this.level0, true);
      this.active = 'level0';
      this.colliders = this.level0.colliders;
      this.player.setPosition(L0.upLadderArrival.x, L0.upLadderArrival.y);
      this.setCameraBounds(this.level0.bounds);
      this.cameras.main.centerOn(L0.upLadderArrival.x, L0.upLadderArrival.y);
      // same "arrival lands inside the level's own return trigger" issue
      // as goToLevel1() above — arm it so update() doesn't immediately
      // send the player straight back to L1.
      this.level0.upLadderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  goToLevel1FromL0() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] ladder -> Level 1 (ground floor), from control room');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level0, false);
      HangarScene.setLevelVisible(this.level1, true);
      this.active = 'level1';
      this.colliders = this.level1.colliders;
      this.player.setPosition(L1.downLadderReturn.x, L1.downLadderReturn.y);
      this.setCameraBounds(this.level1.bounds);
      this.cameras.main.centerOn(L1.downLadderReturn.x, L1.downLadderReturn.y);
      // this is the one the story intro actually hits first (L0 is now
      // the game's starting level) — without arming it here, the
      // player's very first arrival in L1 immediately bounces straight
      // back down to L0 before they can take a single step. Confirmed
      // via a real playthrough test, not just theory.
      this.level1.downLadderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  goToLevel3() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] hatch -> Level 3 (commander room)');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level2, false);
      HangarScene.setLevelVisible(this.level3, true);
      this.active = 'level3';
      this.colliders = this.level3.colliders;
      this.player.setPosition(L3.upLadderArrival.x, L3.upLadderArrival.y);
      this.setCameraBounds(this.level3.bounds);
      this.cameras.main.centerOn(L3.upLadderArrival.x, L3.upLadderArrival.y);
      // same fix as L1/L0 above — the arrival sits inside L3's own
      // upLadderTrigger zone.
      this.level3.upLadderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  goToLevel2FromL3() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] ladder -> Level 2 (catwalk), from commander room');
    this.cameras.main.fadeOut(180, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this.level3, false);
      HangarScene.setLevelVisible(this.level2, true);
      this.active = 'level2';
      this.colliders = this.level2.colliders;
      this.player.setPosition(L2.downLadderReturn.x, L2.downLadderReturn.y);
      this.setCameraBounds(this.level2.bounds);
      this.cameras.main.centerOn(L2.downLadderReturn.x, L2.downLadderReturn.y);
      // same fix as the others — the arrival sits inside L2's own
      // downLadderTrigger zone.
      this.level2.downLadderFired = true;
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this.cameras.main.fadeIn(200, 0, 0, 0);
    });
  }

  /** wallet form submitted on L2 -> the ending Dock corridor. Not a
   *  walk-into-trigger transition like the others (there's no ladder to
   *  step through) — story.js's wallet onSubmit calls this directly once
   *  the form closes. Fades a beat longer than the ladder hops (1200ms vs
   *  180ms) since this is a narrative beat, not a quick level hop.
   *  `this[this.active]` (not a hardcoded 'level2') hides whichever level
   *  the terminal was actually used from — in practice always L2, but
   *  matching every other goToLevelX's own-level-agnostic pattern costs
   *  nothing. */
  goToDock() {
    if (this._transitioning) return;
    this._transitioning = true;
    console.log('[HangarScene] wallet linked -> Dock (ending corridor)');
    this.cameras.main.fadeOut(1200, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      HangarScene.setLevelVisible(this[this.active], false);
      HangarScene.setLevelVisible(this.dock, true);
      this.active = 'dock';
      this.colliders = this.dock.colliders;
      this.player.setPosition(DOCK.spawn.x, DOCK.spawn.y);
      // face the player toward the Operator (west) on arrival — update()
      // won't touch facing again until the player actually presses a
      // movement key, so without this they'd stand facing whatever
      // direction they last walked in the level before.
      this.player.facing = 'left';
      this.player.sprite.play('pilot-idle-left');
      this.player._facingApplied = 'left';
      this.player._moving = false;
      this.setCameraBounds(this.dock.bounds);
      this.cameras.main.centerOn(DOCK.spawn.x, DOCK.spawn.y);
      this._enteredAt = this.time.now;
      this._transitioning = false;
      this._playerLocked = false;
      this.objectiveBanner.show('Find the Operator');
      this.cameras.main.fadeIn(1200, 0, 0, 0);
    });
  }

  /** the current story build's ending: once the Operator's Dock dialogue
   *  closes, lock the player, fade to black, then play the outro video
   *  full-screen over the (now black) canvas. No fade back in once the
   *  video ends/is skipped/fails to load — it just leaves the canvas
   *  black, since there's nothing to play after this yet (see the brief
   *  this was built against — "nothing after it yet"). */
  endStory() {
    this._playerLocked = true;
    this.objectiveBanner.hide();
    this.toast.container.setVisible(false);
    this.cameras.main.fadeOut(2200, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      playVideoOverlay(`${ASSET_BASE}/video/outro.mp4`, () => showEndScreen());
    });
  }

  setCameraBounds(b) {
    this.cameras.main.setBounds(b.x, b.y, b.width, b.height);
  }

  // ---------------------------------------------------------------------

  resolveMove(nx, ny) {
    const bounds = this[this.active].bounds;
    const cx = Phaser.Math.Clamp(nx, WALL_T + PLAYER_R, bounds.width - WALL_T - PLAYER_R);
    const cy = Phaser.Math.Clamp(ny, WALL_T + PLAYER_R, bounds.height - WALL_T - PLAYER_R);
    return resolveMove(this.colliders, this.player.x, this.player.y, cx, cy, PLAYER_R);
  }

  buildDebug() {
    this.dbg = this.add.graphics().setDepth(999998);
    this.hud = this.add.text(8, 8, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '12px',
      color: '#e9e7e0', backgroundColor: '#000000a0', padding: { x: 6, y: 4 },
    }).setScrollFactor(0).setDepth(999999);
  }

  update(_time, delta) {
    const dt = delta / 1000;

    if (this._hintLevel !== this.active) {
      this._hintLevel = this.active;
      const move = isTouchDevice() ? 'Stick to move' : 'WASD/Arrows to move';
      this.hintText.setText(`${move} · ${LEVEL_HINTS[this.active] ?? ''}`);
    }

    // Wanderers on each level only need to move while THAT level is the
    // active/visible one — updating their collider positions BEFORE the
    // player moves this frame so the player's own resolveMove sees
    // up-to-date obstacles, not last frame's.
    if (!this._transitioning) {
      const lv = this[this.active];
      for (const w of lv.wanderers) {
        const obstacles = lv.colliders.filter((r) => r !== w.collider);
        w.update(dt, obstacles);
      }
    }

    if (!this._transitioning && !this.dialogue.isOpen && !this._playerLocked && !this._formOpen) this.player.update(dt);

    // ---- ASK indicators: each interactable shows its own badge when the
    // player is within range of IT specifically (not just "nearest") AND
    // it reports itself active — the Level 2 terminal is only "active"
    // during its two story windows, everything else is always active.
    // All hidden while a dialogue/form is open or the player is story-
    // locked. `_nearestInteractable` (closest active one in range) is
    // what Space/Enter actually triggers. ----
    if (!this._transitioning) {
      const lv = this[this.active];
      const DEFAULT_RANGE = 46;
      let nearest = null, nearestDist = Infinity;
      const canInteract = !this.dialogue.isOpen && !this._formOpen && !this._playerLocked;
      for (const it of lv.interactables) {
        const active = it.isActive ? it.isActive() : true;
        const dx = it.getX() - this.player.x, dy = it.getY() - this.player.y;
        const d = Math.hypot(dx, dy);
        // per-interactable override: the L1 "legs" welder sits far enough
        // inside the mecha's own collider that the player can never walk
        // closer than ~53px to him (confirmed by testing), so the
        // default 46px range never triggers for him specifically — every
        // other NPC/terminal is fine at the default.
        const range = it.range ?? DEFAULT_RANGE;
        const inRange = active && canInteract && d < range;
        it.indicator.update(it.getX(), it.getY(), dt);
        it.indicator.setVisible(inRange);
        if (inRange && d < nearestDist) { nearest = it; nearestDist = d; }
      }
      this._nearestInteractable = nearest;
    }

    const grace = this.time.now - this._enteredAt > 400;

    if (this.active === 'level1' && grace && !this._transitioning) {
      const lv = this.level1;
      const insideUp = Phaser.Geom.Rectangle.Contains(lv.upLadderTrigger, this.player.x, this.player.y);
      if (insideUp && !lv.upLadderFired) { lv.upLadderFired = true; this.goToLevel2(); }
      else if (!insideUp) lv.upLadderFired = false;

      const insideDown = Phaser.Geom.Rectangle.Contains(lv.downLadderTrigger, this.player.x, this.player.y);
      if (insideDown && !lv.downLadderFired) { lv.downLadderFired = true; this.goToLevel0(); }
      else if (!insideDown) lv.downLadderFired = false;
    }
    if (this.active === 'level2' && grace && !this._transitioning) {
      const lv = this.level2;
      const insideDown = Phaser.Geom.Rectangle.Contains(lv.ladderTrigger, this.player.x, this.player.y);
      if (insideDown && !lv.ladderFired) { lv.ladderFired = true; this.goToLevel1(); }
      else if (!insideDown) lv.ladderFired = false;

      const insideDown2 = Phaser.Geom.Rectangle.Contains(lv.downLadderTrigger, this.player.x, this.player.y);
      if (insideDown2 && !lv.downLadderFired) { lv.downLadderFired = true; this.goToLevel3(); }
      else if (!insideDown2) lv.downLadderFired = false;
    }
    if (this.active === 'level0' && grace && !this._transitioning) {
      const lv = this.level0;
      const inside = Phaser.Geom.Rectangle.Contains(lv.upLadderTrigger, this.player.x, this.player.y);
      if (inside && !lv.upLadderFired) { lv.upLadderFired = true; this.goToLevel1FromL0(); }
      else if (!inside) lv.upLadderFired = false;
    }
    if (this.active === 'level3' && grace && !this._transitioning) {
      const lv = this.level3;
      const inside = Phaser.Geom.Rectangle.Contains(lv.upLadderTrigger, this.player.x, this.player.y);
      if (inside && !lv.upLadderFired) { lv.upLadderFired = true; this.goToLevel2FromL3(); }
      else if (!inside) lv.upLadderFired = false;
    }

    if (this.dbg) {
      this.dbg.clear();
      for (const c of this.colliders) {
        this.dbg.lineStyle(1, 0xff5a5a, 0.85).strokeRectShape(c);
        this.dbg.fillStyle(0xff5a5a, 0.12).fillRectShape(c);
      }
      // level1 and level2 each have two trigger zones live at once — draw
      // whichever ones apply to the active level, each independently "hot"
      const trigs = this.active === 'level1' ? [this.level1.upLadderTrigger, this.level1.downLadderTrigger]
        : this.active === 'level2' ? [this.level2.ladderTrigger, this.level2.downLadderTrigger]
          : this.active === 'level0' ? [this.level0.upLadderTrigger]
            : this.active === 'level3' ? [this.level3.upLadderTrigger]
              : []; // dock: no ladder/hatch triggers — reached via goToDock()
      for (const trig of trigs) {
        const hot = Phaser.Geom.Rectangle.Contains(trig, this.player.x, this.player.y);
        this.dbg.lineStyle(1, hot ? 0xffe08a : 0x2ad17a, 0.9).strokeRectShape(trig);
        this.dbg.fillStyle(hot ? 0xffe08a : 0x2ad17a, 0.12).fillRectShape(trig);
      }

      const hint = this.active === 'level1' ? 'WASD/Arrows to move · ladder up to L2 · floor hatch down to L0'
        : this.active === 'level2' ? 'WASD/Arrows to move · east ladder down to L1 · west hatch down to L3'
          : this.active === 'level0' ? 'WASD/Arrows to move · walk into the ladder to go back up to L1'
            : this.active === 'level3' ? 'WASD/Arrows to move · walk into the ladder to go back up to L2'
              : 'WASD/Arrows to move · find the Operator west along the dock';
      this.hud.setText([
        `level ${this.active}   ·   player x ${this.player.x.toFixed(0)} y ${this.player.y.toFixed(0)}  facing ${this.player.facing}`,
        `colliders ${this.colliders.length}   ·   fps ${this.game.loop.actualFps.toFixed(0)}`,
        hint,
      ]);
    }
  }
}
