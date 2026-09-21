import { drawAngularPanel, AskIndicator } from './dialogue.js';

/**
 * ENGINE 44 — opening story sequence.
 *
 * Everything here is content + a thin layer of gating logic bolted onto
 * the dialogue/indicator/screen-shake plumbing that already exists
 * (dialogue.js, HangarScene's interactable system). Nothing in here
 * touches Phaser scene-graph internals directly except the small UI
 * widgets at the bottom (ObjectiveBanner, StoryToast — same angular-HUD
 * language as DialogueBox/AskIndicator) and the HTML form overlay (real
 * <input> fields aren't something Phaser/canvas does well, so the two
 * forms are a DOM layer on top of the canvas, styled to match).
 *
 * Progression is five boolean flags, checked in order — no state
 * machine library, just "if the previous thing is done and this thing
 * isn't, do this thing":
 *   beat1Done          -> talked to the L1 Professor
 *   registrationDone   -> submitted the registration form
 *   beat2Done          -> talked to the L2 Professor AFTER registering
 *   beat3Done          -> talked to the L1 "legs" Welder AFTER beat2
 *   beat4Done          -> talked to the Commander AFTER beat3
 *   walletSubmitted    -> submitted the wallet form AFTER beat4
 */

export function createStoryState() {
  return {
    introDone: false,
    beat1Done: false,
    registrationDone: false,
    beat2Done: false,
    beat3Done: false,
    beat4Done: false,
    walletSubmitted: false,
  };
}

// ---------------------------------------------------------------------
// Dialogue content — every NPC's lines, story-relevant or not, live here
// so resolveNpcDialogue has one place to read from. The "default filler"
// entries are the same placeholder lines from the dialogue-system
// foundation round; special beats override them once their gate opens.
// ---------------------------------------------------------------------

export const NPC_DIALOGUE = {
  npc_professor: {
    name: 'Professor',
    portraitKey: 'portrait_professor',
    lines: [
      'Systems check complete. Structural integrity within tolerance.',
      "The mecha's readings look stable today — better than yesterday, at least.",
    ],
  },
  npc_mechanic: {
    name: 'Mechanic',
    portraitKey: 'portrait_mechanic',
    lines: [
      "Just tightening a few bolts here. She'll hold — probably.",
      "Don't mind me, just keeping this old girl running.",
    ],
  },
  npc_welder: {
    name: 'Welder',
    portraitKey: 'portrait_welder',
    lines: [
      'Almost got this weld sealed. Give me a minute.',
      "Sparks fly, seams hold. That's the job.",
    ],
  },
  npc_commander: {
    name: 'Commander',
    portraitKey: 'portrait_commander',
    lines: [
      'State your business. This deck is not a walkway.',
      'Every deployment goes through me first. That is not a courtesy — it is procedure.',
    ],
  },
  npc_operator: {
    name: 'Operator',
    portraitKey: 'portrait_operator',
    lines: [
      'Careful out there.',
      "I'll keep feeding you enemy positions the whole way — you won't be flying blind.",
      "Your ENGINE's ready. Go get 'em.",
    ],
  },
};

export const INTRO_LINES = [
  "What was that? Are we under attack? It's barely morning...",
  'Damn it. I need to get ready.',
];

const BEAT1_LINES = [
  'Your ENGINE 44 unit is still undergoing repairs.',
  "Go find the Professor on Level 2 — ask them if it's ready for deployment.",
];

const BEAT2A_LINES = [
  'Before deployment, you need to register.',
  'Head to the terminal in front of the mecha — get it done, then come find me again.',
];

const BEAT2B_LINES = [
  'Registered? Good.',
  'Go speak with the Welder on Level 1 — the one working on the legs. Ask if the unit is ready.',
];

const BEAT3_LINES = [
  "She's ready to fly. Structural welds are solid.",
  "But you'll need the Commander's sign-off before you can pilot her. He's in the Commander Room, Level 3.",
];

// Commander-led rather than alternating Pilot/Commander lines — DialogueBox
// shows one speaker (one portrait) per open() call, so a true back-and-
// forth would need mid-conversation speaker switching that doesn't exist
// yet. Hits all four required beats as one continuous order from him.
const BEAT4_LINES = [
  'Sit down, Pilot. This is not a routine assignment.',
  "Ashfall's surface has hostile anomalies — creatures scaled like our own mechas, and they don't hesitate.",
  'They already hit our expedition team. We lost contact six hours ago.',
  'Forge Command does not sit on losses like that. We hit back, and we hit back now.',
  'Suit up. Get to your ENGINE and deploy. That is a direct order.',
];

const FLAVOR_DISMISSIVE_LINES = [
  'Not now — we\'re swamped. Go find the Professor.',
];

/**
 * Decide what an NPC says right now, given the story state.
 * @param {object} story - the flags object from createStoryState()
 * @param {string} prefix - NPC sprite-prefix, e.g. 'npc_professor'
 * @param {object} ctx
 * @param {string} ctx.levelId - 'level0'|'level1'|'level2'|'level3'
 * @param {boolean} [ctx.isWelderLegs] - true only for the L1 welder posted
 *   at the mecha's feet — the one specific welder beat 3 talks about,
 *   distinct from every other (generic) welder/mechanic instance
 * @param {(text: string) => void} ctx.setObjective - updates the banner
 * @returns {{name: string, portraitKey: string, lines: string[], onClose?: () => void} | null}
 */
export function resolveNpcDialogue(story, prefix, ctx) {
  const { levelId, isWelderLegs, setObjective } = ctx;

  if (prefix === 'npc_professor' && levelId === 'level1' && !story.beat1Done) {
    return {
      name: 'Professor', portraitKey: 'portrait_professor', lines: BEAT1_LINES,
      onClose: () => { story.beat1Done = true; setObjective('Find the Professor on Level 2'); },
    };
  }

  if (prefix === 'npc_professor' && levelId === 'level2') {
    if (story.registrationDone && !story.beat2Done) {
      return {
        name: 'Professor', portraitKey: 'portrait_professor', lines: BEAT2B_LINES,
        onClose: () => { story.beat2Done = true; setObjective('Find the Welder on Level 1'); },
      };
    }
    if (story.beat1Done && !story.registrationDone) {
      return {
        name: 'Professor', portraitKey: 'portrait_professor', lines: BEAT2A_LINES,
        onClose: () => setObjective('Register at the Level 2 terminal'),
      };
    }
  }

  if (prefix === 'npc_welder' && isWelderLegs && story.beat2Done && !story.beat3Done) {
    return {
      name: 'Welder', portraitKey: 'portrait_welder', lines: BEAT3_LINES,
      onClose: () => { story.beat3Done = true; setObjective('Get approval from the Commander (Level 3)'); },
    };
  }

  if (prefix === 'npc_commander' && story.beat3Done && !story.beat4Done) {
    return {
      name: 'Commander', portraitKey: 'portrait_commander', lines: BEAT4_LINES,
      onClose: () => {
        story.beat4Done = true;
        setObjective('Return to Level 2 and access the terminal to launch your ENGINE');
      },
    };
  }

  // The Dock's Operator — her one scripted conversation closes out the
  // current story build. `ctx.onDockOperatorDone` is HangarScene's
  // endStory() (wired in via addInteractable's ctx bag, same convention
  // as isWelderLegs above), not a story flag — she has no second state to
  // gate on, this is the only thing she ever says.
  if (prefix === 'npc_operator' && levelId === 'dock') {
    const info = NPC_DIALOGUE.npc_operator;
    return {
      name: info.name, portraitKey: info.portraitKey, lines: info.lines,
      onClose: () => { ctx.onDockOperatorDone?.(); },
    };
  }

  // Flavor: any mechanic/welder OTHER than an active special beat above,
  // brushes the player off while beat 1 is still outstanding.
  if ((prefix === 'npc_mechanic' || prefix === 'npc_welder') && !story.beat1Done) {
    const info = NPC_DIALOGUE[prefix];
    return { name: info.name, portraitKey: info.portraitKey, lines: FLAVOR_DISMISSIVE_LINES };
  }

  const fallback = NPC_DIALOGUE[prefix];
  return fallback ? { name: fallback.name, portraitKey: fallback.portraitKey, lines: fallback.lines } : null;
}

// ---------------------------------------------------------------------
// The Level 2 terminal bank — not an NPC, so it doesn't go through
// resolveNpcDialogue. Only "active" (ASK-able) during the two windows
// where it actually does something; otherwise it's just scenery.
// ---------------------------------------------------------------------

export function createTerminalInteractable(scene, story, x, y) {
  // NOT pushed into scene.uiObjects — same reasoning as addInteractable()
  // in HangarScene.js: this tracks a world position and must render via
  // the main (scrolling/zoomed) camera, not the static UI camera.
  const indicator = new AskIndicator(scene, 'USE');

  return {
    getX: () => x,
    getY: () => y,
    indicator,
    isActive: () => (
      (story.beat1Done && !story.registrationDone)
      || (story.beat4Done && !story.walletSubmitted)
    ),
    onInteract: () => {
      if (story.beat4Done && !story.walletSubmitted) {
        showForm(scene, {
          title: 'ENGINE LAUNCH — WALLET LINK',
          fields: [
            { id: 'wallet', label: 'EVM Wallet Address', placeholder: '0x...' },
          ],
          submitLabel: 'Submit',
          onSubmit: () => {
            story.walletSubmitted = true;
            scene._playerLocked = true;
            // the objective banner (and any still-fading toast) live on
            // the separate UI camera so the dialogue box/HUD survive the
            // main camera's zoom — but that also means goToDock()'s own
            // fadeOut below does NOT touch them. Hide them explicitly so
            // the fade-out is a clean black screen, not one with the last
            // objective still hanging over it (goToDock shows its own
            // "Find the Operator" banner once it fades back in).
            scene.objectiveBanner.hide();
            scene.toast.container.setVisible(false);
            // was a flat fadeOut-and-stop; now transitions into the Dock
            // corridor instead of ending on an empty black screen — see
            // HangarScene.goToDock().
            scene.goToDock();
          },
        });
        return;
      }
      if (story.beat1Done && !story.registrationDone) {
        showForm(scene, {
          title: 'FORGE COMMAND — REGISTRATION',
          fields: [
            { id: 'handle', label: 'Name / X (Twitter) Handle', placeholder: 'pilot_handle', prefix: '@' },
          ],
          links: [
            { label: 'Follow @ENGINE44' },
            { label: 'RT / Like / Comment' },
          ],
          submitLabel: 'Submit',
          onSubmit: () => {
            story.registrationDone = true;
            scene.toast.flash('Registration complete.');
            // Fills the gap between "form closes" and "player re-triggers the
            // Professor's L2 dialogue" (see resolveNpcDialogue's registrationDone
            // branch below) — without this the banner kept showing the just-
            // completed "Register at the Level 2 terminal" objective.
            scene.objectiveBanner.show('Report back to the Professor on Level 2');
          },
        });
      }
    },
  };
}

// ---------------------------------------------------------------------
// ObjectiveBanner — persistent "OBJECTIVE: ..." strip, top-center.
// Same fixed-to-UI-camera treatment as the dialogue box (see
// HangarScene's uiCamera split) and same angular-panel language.
// One instance, text updated in place — never stacks.
// ---------------------------------------------------------------------

export class ObjectiveBanner {
  constructor(scene) {
    this.scene = scene;
    const { width } = scene.scale;
    const w = Math.min(480, width - 40);
    const h = 38;
    this.container = scene.add.container(width / 2, 28).setScrollFactor(0).setDepth(1_900_000).setVisible(false);

    const g = scene.add.graphics();
    drawAngularPanel(g, w, h, { chamfer: 10 });
    this.container.add(g);

    this.label = scene.add.text(-w / 2 + 16, 0, 'OBJECTIVE', {
      fontFamily: '"Stardos Stencil", "Arial Black", Impact, sans-serif',
      fontSize: '13px',
      color: '#ff7a33',
    }).setOrigin(0, 0.5);
    this.container.add(this.label);

    this.text = scene.add.text(-w / 2 + 118, 0, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '12.5px',
      color: '#e9e7e0',
      wordWrap: { width: w - 134 },
    }).setOrigin(0, 0.5);
    this.container.add(this.text);
  }

  show(text) {
    this.text.setText(text);
    this.container.setVisible(true);
  }

  hide() { this.container.setVisible(false); }
}

// ---------------------------------------------------------------------
// StoryToast — small transient confirmation flash (e.g. "Registration
// complete."), separate from the persistent objective banner so a
// one-off confirmation never overwrites (or gets overwritten by) the
// current objective text.
// ---------------------------------------------------------------------

export class StoryToast {
  constructor(scene) {
    this.scene = scene;
    this.container = scene.add.container(scene.scale.width / 2, 78).setScrollFactor(0).setDepth(1_900_001).setVisible(false);

    const g = scene.add.graphics();
    drawAngularPanel(g, 280, 34, { chamfer: 8, line: 0x4ade80 });
    this.container.add(g);

    this.text = scene.add.text(0, 0, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '12px',
      color: '#e9e7e0',
    }).setOrigin(0.5);
    this.container.add(this.text);

    this._timer = null;
  }

  flash(text, duration = 2600) {
    this.text.setText(text);
    this.container.setVisible(true).setAlpha(1);
    if (this._timer) this._timer.remove();
    this._timer = this.scene.time.delayedCall(duration, () => {
      this.scene.tweens.add({
        targets: this.container, alpha: 0, duration: 400,
        onComplete: () => this.container.setVisible(false),
      });
    });
  }
}

// ---------------------------------------------------------------------
// showForm — a real HTML overlay (Phaser/canvas has no text-input
// widget) styled to match the in-game angular/rust-orange HUD. Captures
// input, logs it, calls onSubmit with the values, then removes itself.
// No network call — per spec this doesn't send anywhere yet.
// ---------------------------------------------------------------------

export function showForm(scene, { title, fields, links = [], submitLabel = 'Submit', onSubmit }) {
  scene._formOpen = true;
  scene.input.keyboard.enabled = false;
  // `enabled = false` alone stops Phaser from acting on keys, but WASD/arrows
  // are registered as global captures (see PilotPlayer's createCursorKeys/
  // addKeys) — captures call event.preventDefault() at the DOM level BEFORE
  // Phaser even checks `enabled`, which silently ate every w/a/s/d keystroke
  // typed into the field below. disableGlobalCapture() turns that off for
  // as long as this form is open.
  scene.input.keyboard.disableGlobalCapture();

  const overlay = document.createElement('div');
  overlay.className = 'story-overlay';

  const panel = document.createElement('form');
  panel.className = 'story-panel';
  panel.noValidate = false;

  const h2 = document.createElement('h2');
  h2.textContent = title;
  panel.appendChild(h2);

  const inputs = {};
  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'story-field';

    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = f.id;
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.className = 'story-input-row';
    if (f.prefix) {
      const pre = document.createElement('span');
      pre.className = 'story-input-prefix';
      pre.textContent = f.prefix;
      row.appendChild(pre);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.id = f.id;
    input.name = f.id;
    input.placeholder = f.placeholder || '';
    input.required = true;
    input.autocomplete = 'off';
    row.appendChild(input);
    wrap.appendChild(row);
    panel.appendChild(wrap);
    inputs[f.id] = input;
  }

  if (links.length) {
    const linkRow = document.createElement('div');
    linkRow.className = 'story-links';
    for (const l of links) {
      const a = document.createElement('a');
      a.className = 'story-link-btn';
      a.href = '#';
      a.textContent = l.label;
      // Real destinations aren't known yet (placeholder per spec) — inert
      // by design rather than guessing a URL that might be wrong.
      a.addEventListener('click', (e) => e.preventDefault());
      linkRow.appendChild(a);
    }
    panel.appendChild(linkRow);
  }

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'story-submit';
  submit.textContent = submitLabel;
  panel.appendChild(submit);

  const hint = document.createElement('div');
  hint.className = 'story-hint';
  hint.textContent = 'Esc to cancel';
  panel.appendChild(hint);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const firstField = fields[0];
  if (firstField) inputs[firstField.id].focus();

  function cleanup() {
    overlay.remove();
    window.removeEventListener('keydown', onKey);
    scene._formOpen = false;
    scene.input.keyboard.enabled = true;
    scene.input.keyboard.enableGlobalCapture();
  }
  function onKey(e) {
    if (e.key === 'Escape') cleanup();
  }
  window.addEventListener('keydown', onKey);

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = {};
    for (const id in inputs) values[id] = inputs[id].value.trim();
    console.log('[ENGINE44 story] form submitted:', title, values);
    cleanup();
    onSubmit?.(values);
  });
}

// ---------------------------------------------------------------------
// showEndScreen — final screen of the current story build, shown once
// the outro video finishes/is skipped/fails to load. Same DOM-overlay
// approach as showForm (Phaser/canvas has no easy way to lay out
// multi-line centered text over a video element that's already gone by
// this point anyway). Permanent — no close control, nothing plays after
// this yet, the player just closes the tab.
// ---------------------------------------------------------------------
export function showEndScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'end-overlay';
  overlay.innerHTML = `
    <div class="end-panel">
      <h2>ALL SET — YOU'RE ON THE LIST</h2>
      <p>You can close this tab now.</p>
    </div>
  `;
  document.body.appendChild(overlay);
}
