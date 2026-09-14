// Shared world helpers used by every walkable scene.

/** First rect in `rects` that contains (x,y) inflated by `pad`, else null. */
export function hitRect(rects, x, y, pad = 0) {
  for (const r of rects) {
    if (x > r.left - pad && x < r.right + pad
      && y > r.top - pad && y < r.bottom + pad) return r;
  }
  return null;
}

/**
 * Separable-axis collision resolution: given the current position (fromX,fromY)
 * and a desired position (toX,toY), block the axis/axes that would enter a solid
 * rect so the mover slides along walls. `pad` is the mover's radius.
 * If already inside a rect, the move is allowed (so it can escape).
 */
export function resolveMove(rects, fromX, fromY, toX, toY, pad = 7) {
  let x = toX;
  let y = toY;
  if (hitRect(rects, fromX, fromY, pad)) return { x, y };
  if (hitRect(rects, x, fromY, pad)) x = fromX;
  if (hitRect(rects, x, y, pad)) y = fromY;
  return { x, y };
}
