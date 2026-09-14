/**
 * ENGINE 44 — full-screen MP4 intro/outro overlay.
 *
 * A plain HTML5 <video> layered on top of the game canvas (inside the
 * #game div — see index.html's `#game { position: relative }` and the
 * .video-overlay rule) rather than Phaser's own Video game object: a
 * DOM element gives simpler, more reliable codec/seek/skip/error
 * handling than piping video frames through the WebGL/canvas pipeline,
 * and this project already leans on plain DOM overlays for anything
 * text-input-shaped (see story.js's showForm) — same pattern here.
 *
 * Autoplay policy: starts muted (required for autoplay in every major
 * browser) with an explicit unmute button — never assume the browser
 * honors the `autoplay` attribute alone for a dynamically-inserted
 * element, so `.play()` is also called directly.
 *
 * Never gets stuck: a load error (missing file, bad codec) finishes
 * immediately, and a safety timeout finishes even if the browser never
 * fires an error/metadata event at all — both paths call onDone just
 * like a normal end-of-video or a Skip click, so the caller only ever
 * needs to handle one outcome.
 */

const LOAD_TIMEOUT_MS = 8000;

/**
 * @param {string} src - video URL, e.g. '/assets/video/intro.mp4'
 * @param {() => void} onDone - called exactly once: on end, skip, load
 *   error, or load timeout
 */
export function playVideoOverlay(src, onDone) {
  const gameEl = document.getElementById('game');
  let done = false;

  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';

  const video = document.createElement('video');
  video.className = 'video-overlay-el';
  video.src = src;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', ''); // older Safari reads the attribute, not just the property
  overlay.appendChild(video);

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'video-skip-btn';
  skipBtn.textContent = 'SKIP ▸';
  overlay.appendChild(skipBtn);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'video-mute-btn';
  muteBtn.textContent = '🔇 UNMUTE';
  overlay.appendChild(muteBtn);

  const loadTimer = setTimeout(finish, LOAD_TIMEOUT_MS);

  function finish() {
    if (done) return;
    done = true;
    clearTimeout(loadTimer);
    overlay.remove();
    onDone();
  }

  skipBtn.addEventListener('click', finish);
  video.addEventListener('ended', finish);
  video.addEventListener('error', finish);
  video.addEventListener('loadedmetadata', () => clearTimeout(loadTimer));
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇 UNMUTE' : '🔊 MUTE';
  });

  gameEl.appendChild(overlay);
  // belt-and-suspenders on top of the `autoplay` attribute — some browsers
  // only honor autoplay on elements present at initial parse, not ones
  // inserted afterward via JS.
  video.play().catch(finish);
}
