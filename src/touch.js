/**
 * ENGINE 44 — on-screen touch controls (virtual joystick + interact button).
 *
 * Plain DOM overlays rather than Phaser objects: DOM pointer events give
 * real simultaneous multi-touch (hold the stick AND tap the button) and
 * sidestep the main-camera/UI-camera zoom split entirely (see
 * HangarScene's UI camera comment).
 *
 * Visibility is pure CSS — `.touch-controls` is display:none unless
 * <html> has the `touch` class (set below when the primary pointer is
 * coarse), so mouse/keyboard users never see it. Append `?touch=1` to
 * the URL to force it on for testing on a desktop browser.
 */

/** Shared movement state, OR'd with the keyboard in PilotPlayer.update(). */
export const touchInput = { left: false, right: false, up: false, down: false };

const forced = new URLSearchParams(window.location.search).get('touch') === '1';

export function isTouchDevice() {
  return forced || window.matchMedia('(pointer: coarse)').matches;
}

// CSS hook (index.html): touch layout + control visibility hang off html.touch
if (isTouchDevice()) document.documentElement.classList.add('touch');

const DEADZONE = 0.25; // fraction of stick radius
const AXIS_THRESHOLD = 0.38; // |normalized component| needed to count as pressed; 0.38 gives clean diagonals around 45deg

/** @param {() => void} onInteract fired on every press of the interact button */
export function createTouchControls(onInteract) {
  const root = document.createElement('div');
  root.className = 'touch-controls';
  root.innerHTML = `
    <div class="tc-stick"><div class="tc-knob"></div></div>
    <button type="button" class="tc-interact" aria-label="Interact">INTERACT</button>
  `;
  document.body.appendChild(root);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  const stick = root.querySelector('.tc-stick');
  const knob = root.querySelector('.tc-knob');
  const button = root.querySelector('.tc-interact');

  let activeId = null;

  function release() {
    activeId = null;
    touchInput.left = touchInput.right = touchInput.up = touchInput.down = false;
    knob.style.transform = 'translate(-50%, -50%)';
  }

  function track(e) {
    const rect = stick.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = e.clientX - (rect.left + radius);
    const dy = e.clientY - (rect.top + radius);
    const dist = Math.hypot(dx, dy);

    const maxKnob = radius - knob.offsetWidth / 2;
    const k = dist > maxKnob ? maxKnob / dist : 1;
    knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;

    if (dist < radius * DEADZONE) {
      touchInput.left = touchInput.right = touchInput.up = touchInput.down = false;
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    touchInput.right = nx > AXIS_THRESHOLD;
    touchInput.left = nx < -AXIS_THRESHOLD;
    touchInput.down = ny > AXIS_THRESHOLD;
    touchInput.up = ny < -AXIS_THRESHOLD;
  }

  stick.addEventListener('pointerdown', (e) => {
    if (activeId !== null) return;
    e.preventDefault();
    activeId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    track(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === activeId) track(e);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(type, (e) => {
      if (e.pointerId === activeId) release();
    });
  }

  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onInteract();
  });

  // a stuck-down stick when the tab is hidden would keep the pilot walking
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  return root;
}
