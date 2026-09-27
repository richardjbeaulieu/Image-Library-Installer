// Makes a solid background transparent: the kind of background clipart, logos, and product cut-outs sit on.
//
// It floods inward from the edges of the picture, clearing every pixel that matches the background colour,
// and stops at the artwork. Pixels close to the artwork's edge get partial transparency so edges stay smooth
// instead of jagged. Anything enclosed by the artwork (a gap inside a letter "O", say) is only cleared if the
// flood can reach it from outside, so holes in the middle of a design are kept.

// Straight-line distance between two colours (0 = identical, ~441 = black vs white).
function distance(data, i, r, g, b) {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// The colour the picture sits on, taken from its outer frame (the median, so a few stray pixels don't matter).
function backgroundColour(data, width, height) {
  const reds = [];
  const greens = [];
  const blues = [];
  const push = (x, y) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128) return; // already transparent there
    reds.push(data[i]);
    greens.push(data[i + 1]);
    blues.push(data[i + 2]);
  };
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  for (let x = 0; x < width; x += stepX) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    push(0, y);
    push(width - 1, y);
  }
  if (!reds.length) return null;
  const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  return { r: median(reds), g: median(greens), b: median(blues) };
}

/**
 * data: RGBA pixels, changed in place.
 * tolerance: 0-100. How different a pixel may be from the background colour and still count as background.
 * feather: soften the boundary between artwork and cleared area.
 * insideToo: also clear matching areas enclosed by the artwork (the middle of a wreath, the gap in an "O").
 * Returns { cleared, total, colour } or null when there is no solid background to remove.
 */
function removeBackground(data, width, height, { tolerance = 12, feather = true, insideToo = false } = {}) {
  const colour = backgroundColour(data, width, height);
  if (!colour) return null;
  const { r, g, b } = colour;
  const limit = (tolerance / 100) * 441; // 441 is the largest possible colour distance
  const total = width * height;
  const cleared = new Uint8Array(total);
  const stack = [];

  const consider = (x, y) => {
    const p = y * width + x;
    if (cleared[p]) return;
    const i = p * 4;
    if (data[i + 3] === 0) {
      cleared[p] = 1; // already transparent: flood straight through it
      stack.push(p);
      return;
    }
    if (distance(data, i, r, g, b) <= limit) {
      cleared[p] = 1;
      stack.push(p);
    }
  };

  for (let x = 0; x < width; x++) {
    consider(x, 0);
    consider(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    consider(0, y);
    consider(width - 1, y);
  }

  // With insideToo, every pixel matching the background colour is cleared, even where the artwork encloses it.
  if (insideToo) {
    for (let p = 0; p < total; p++) {
      if (cleared[p]) continue;
      const i = p * 4;
      if (data[i + 3] === 0 || distance(data, i, r, g, b) <= limit) cleared[p] = 1;
    }
    stack.length = 0;
  }

  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) consider(x - 1, y);
    if (x < width - 1) consider(x + 1, y);
    if (y > 0) consider(x, y - 1);
    if (y < height - 1) consider(x, y + 1);
  }

  let count = 0;
  for (let p = 0; p < total; p++) {
    if (cleared[p]) {
      data[p * 4 + 3] = 0;
      count++;
    }
  }
  if (!count) return { cleared: 0, total, colour };

  if (feather) {
    // Pixels touching the cleared area keep the artwork's colour but fade out with how close they are
    // to the background colour, which hides the hard staircase edge left by the flood.
    const soft = (tolerance / 100) * 441 * 1.8;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (cleared[p]) continue;
        const touching =
          (x > 0 && cleared[p - 1]) ||
          (x < width - 1 && cleared[p + 1]) ||
          (y > 0 && cleared[p - width]) ||
          (y < height - 1 && cleared[p + width]);
        if (!touching) continue;
        const i = p * 4;
        const d = distance(data, i, r, g, b);
        if (d >= soft) continue;
        const alpha = Math.round((d / soft) * data[i + 3]);
        data[i + 3] = Math.min(data[i + 3], alpha);
      }
    }
  }

  return { cleared: count, total, colour };
}

module.exports = { removeBackground, backgroundColour };
