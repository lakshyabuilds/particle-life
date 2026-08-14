"use strict";

const stage = document.getElementById("stage");
const ctx = stage.getContext("2d");

const TYPES = 7;
const NAMES = ["rose", "orange", "yellow", "green", "cyan", "blue", "violet"];
const PALETTE = ["#ff4d6d", "#ffa94d", "#ffe066", "#69db7c", "#3bc9db", "#748ffc", "#e599f7"];

// palette packed as abgr, one uint32 per type, straight into the pixel buffer
const hex = PALETTE.map((h) => {
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return (0xff << 24) | (b << 16) | (g << 8) | r;
});

const FRICTION = 0.88;  // keep high, or the whole thing freezes into a lump
const FORCE = 0.09;
const CURSOR = 0.09;
const CAP = 20000;      // click-to-spawn ceiling

let sw = innerWidth, sh = innerHeight;
let W, H, count, initCount, rmax, cellsX, cellsY, cellW, cellH;
let px, py, vx, vy, kind;
let heads, next;
const mat = new Float32Array(TYPES * TYPES);

let worldCv, wctx, wimg, wbuf;
let zoom = 1, camX, camY;
let paused = false, speed = 1;
let matrixDirty = true;
const mouse = { on: false, x: 0, y: 0, radius: 0, pull: 1 };

function sizeWorld() {
  W = Math.min(innerWidth, 2560);
  H = Math.min(innerHeight, 1440);
  initCount = Math.max(1200, Math.min(9000, Math.round((W * H) / 160)));
  count = initCount;
  rmax = Math.min(105, Math.max(30, Math.sqrt((W * H) / count) * 3.2));
  // need >=3 cells per side, each at least rmax wide, or the wrap misses neighbours
  rmax = Math.min(rmax, W / 3, H / 3);
  cellsX = Math.max(3, Math.floor(W / rmax));
  cellsY = Math.max(3, Math.floor(H / rmax));
  cellW = W / cellsX;
  cellH = H / cellsY;
}

function updateMeta() {
  document.getElementById("meta").textContent =
    TYPES + " colours · " + count.toLocaleString() + " beings · wrapped edges" + (count >= CAP ? " · full" : "");
}

function scatter() {
  for (let i = 0; i < count; i++) {
    px[i] = Math.random() * W;
    py[i] = Math.random() * H;
    vx[i] = 0;
    vy[i] = 0;
    kind[i] = (Math.random() * TYPES) | 0;
  }
}

function rollMat() {
  // negative diagonal: a colour spreads itself out instead of piling up
  for (let i = 0; i < TYPES; i++) {
    for (let j = 0; j < TYPES; j++) {
      mat[i * TYPES + j] = i === j ? -(0.15 + Math.random() * 0.55) : (Math.random() * 2 - 1) * 0.7;
    }
  }
  // cyclic chase: each colour hunts the next and runs from the last
  const chase = 0.45 + Math.random() * 0.5;
  const flee = -(0.15 + Math.random() * 0.45);
  for (let i = 0; i < TYPES; i++) {
    mat[i * TYPES + (i + 1) % TYPES] = Math.min(0.95, chase * (0.7 + Math.random() * 0.5));
    mat[i * TYPES + (i + TYPES - 1) % TYPES] = Math.max(-0.95, flee * (0.7 + Math.random() * 0.5));
  }
}

function loadKnownMatrix() {
  // deterministic fallback, a chase ring that has never gone still on me
  const rest = [0.18, -0.22, 0.12, -0.16];
  for (let i = 0; i < TYPES; i++) {
    let spare = 0;
    for (let j = 0; j < TYPES; j++) {
      if (j === i) mat[i * TYPES + j] = -0.32;
      else if (j === (i + 1) % TYPES) mat[i * TYPES + j] = 0.82;
      else if (j === (i + TYPES - 1) % TYPES) mat[i * TYPES + j] = -0.28;
      else mat[i * TYPES + j] = rest[spare++ % rest.length];
    }
  }
}

function buildGrid(xs, ys, n, cw, ch, cwid, chei, hs, nx) {
  hs.fill(0);  // heads store idx+1, so 0 reads as "empty"
  for (let i = 0; i < n; i++) {
    const cx = Math.min((xs[i] / cwid) | 0, cw - 1);
    const cy = Math.min((ys[i] / chei) | 0, ch - 1);
    const cell = cy * cw + cx;
    nx[i] = hs[cell];
    hs[cell] = i + 1;
  }
}

function physStep(xs, ys, vxs, vys, ks, n, rm, w, h, hs, nx, cw, ch, cwid, chei) {
  const rr = rm * rm;
  const rmin = rm * 0.28;
  const inv = 1 / (rm - rmin);
  const cap = rm / 8;
  const halfW = w * 0.5, halfH = h * 0.5;
  for (let i = 0; i < n; i++) {
    const xi = xs[i], yi = ys[i], ti = ks[i];
    let fx = 0, fy = 0;
    const cx = Math.min((xi / cwid) | 0, cw - 1);
    const cy = Math.min((yi / chei) | 0, ch - 1);
    for (let oy = -1; oy <= 1; oy++) {
      let gy = cy + oy;
      if (gy < 0) gy += ch; else if (gy >= ch) gy -= ch;
      for (let ox = -1; ox <= 1; ox++) {
        let gx = cx + ox;
        if (gx < 0) gx += cw; else if (gx >= cw) gx -= cw;
        let e = hs[gy * cw + gx];
        while (e) {
          const b = e - 1;
          e = nx[b];
          if (b === i) continue;
          // shortest path across the seam, not the long way around
          let dx = xs[b] - xi, dy = ys[b] - yi;
          if (dx > halfW) dx -= w; else if (dx < -halfW) dx += w;
          if (dy > halfH) dy -= h; else if (dy < -halfH) dy += h;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          let f;
          if (d < rmin) {
            f = d / rmin - 1;
          } else {
            // flat at rmin and rmax, peak in the middle
            f = mat[ti * TYPES + ks[b]] * (1 - Math.abs(2 * d - rmin - rm) * inv);
          }
          const s = f / d;
          fx += dx * s;
          fy += dy * s;
        }
      }
    }
    let nvx = (vxs[i] + fx * FORCE) * FRICTION;
    let nvy = (vys[i] + fy * FORCE) * FRICTION;
    const sp = Math.sqrt(nvx * nvx + nvy * nvy);
    if (sp > cap) { nvx = (nvx / sp) * cap; nvy = (nvy / sp) * cap; }
    vxs[i] = nvx; vys[i] = nvy;
    let nxp = xi + nvx, nyp = yi + nvy;
    if (nxp < 0) nxp += w; else if (nxp >= w) nxp -= w;
    if (nyp < 0) nyp += h; else if (nyp >= h) nyp -= h;
    xs[i] = nxp; ys[i] = nyp;
  }
}

function wrapDX(dx) {
  if (dx > W * 0.5) return dx - W;
  if (dx < -W * 0.5) return dx + W;
  return dx;
}

function wrapDY(dy) {
  if (dy > H * 0.5) return dy - H;
  if (dy < -H * 0.5) return dy + H;
  return dy;
}

function poke() {
  const R = mouse.radius, R2 = R * R;
  const ax = mouse.x, ay = mouse.y;
  const k = CURSOR * mouse.pull;
  for (let i = 0; i < count; i++) {
    const dx = wrapDX(ax - px[i]), dy = wrapDY(ay - py[i]);
    const d2 = dx * dx + dy * dy;
    if (d2 >= R2) continue;
    const d = Math.sqrt(d2) || 1;
    const f = (1 - d / R) * k;
    vx[i] += (dx / d) * f;
    vy[i] += (dy / d) * f;
  }
}

function kick(ax, ay, rad, str) {
  const r2 = rad * rad;
  for (let i = 0; i < count; i++) {
    const dx = wrapDX(px[i] - ax), dy = wrapDY(py[i] - ay);
    const d2 = dx * dx + dy * dy;
    if (d2 >= r2 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const f = (1 - d / rad) * str;
    vx[i] += (dx / d) * f;
    vy[i] += (dy / d) * f;
  }
}

function spawn(ax, ay, n, burst) {
  if (count >= CAP) return;
  const can = Math.min(n, CAP - count);
  const R = mouse.radius * 0.75;
  for (let k = 0; k < can; k++) {
    const idx = count + k;
    const ang = Math.random() * 6.2831853;
    const rad = Math.random() * R * 0.65;
    let cx = (ax + Math.cos(ang) * rad) % W;
    let cy = (ay + Math.sin(ang) * rad) % H;
    if (cx < 0) cx += W;
    if (cy < 0) cy += H;
    px[idx] = cx;
    py[idx] = cy;
    const out = burst * (0.4 + Math.random() * 0.9);
    vx[idx] = Math.cos(ang) * out + (Math.random() - 0.5) * 0.7;
    vy[idx] = Math.sin(ang) * out + (Math.random() - 0.5) * 0.7;
    kind[idx] = (Math.random() * TYPES) | 0;
  }
  count += can;
  updateMeta();
}

function trialPass() {
  // test-run the ruleset small first: rejects gas, one blob, and anything that dies
  const n = 320, tw = 420, th = 420;
  const tr = Math.sqrt((tw * th) / n) * 3.2;
  const tcx = Math.max(3, Math.floor(tw / tr)), tcy = Math.max(3, Math.floor(th / tr));
  const tcw = tw / tcx, tch = th / tcy;
  const theads = new Int32Array(tcx * tcy);
  const tnext = new Int32Array(n);
  const tx = new Float32Array(n), ty = new Float32Array(n);
  const tvx = new Float32Array(n), tvy = new Float32Array(n);
  const tk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    tx[i] = Math.random() * tw;
    ty[i] = Math.random() * th;
    tvx[i] = 0; tvy[i] = 0;
    tk[i] = (Math.random() * TYPES) | 0;
  }

  for (let s = 0; s < 240; s++) {
    buildGrid(tx, ty, n, tcx, tcy, tcw, tch, theads, tnext);
    physStep(tx, ty, tvx, tvy, tk, n, tr, tw, th, theads, tnext, tcx, tcy, tcw, tch);
  }
  let es = 0;
  for (let i = 0; i < n; i++) es += Math.sqrt(tvx[i] * tvx[i] + tvy[i] * tvy[i]);
  const early = es / n;

  for (let s = 0; s < 140; s++) {
    buildGrid(tx, ty, n, tcx, tcy, tcw, tch, theads, tnext);
    physStep(tx, ty, tvx, tvy, tk, n, tr, tw, th, theads, tnext, tcx, tcy, tcw, tch);
  }
  let ls = 0;
  for (let i = 0; i < n; i++) ls += Math.sqrt(tvx[i] * tvx[i] + tvy[i] * tvy[i]);
  const late = ls / n;

  const half = tr * 0.55, half2 = half * half;
  const hw = tw * 0.5, hh = th * 0.5;
  const nn = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let dx = tx[j] - tx[i], dy = ty[j] - ty[i];
      if (dx > hw) dx -= tw; else if (dx < -hw) dx += tw;
      if (dy > hh) dy -= th; else if (dy < -hh) dy += th;
      if (dx * dx + dy * dy < half2) c++;
    }
    nn[i] = c;
    sum += c;
  }
  const mean = sum / n;
  if (mean <= 0) return false;
  let dev = 0;
  for (let i = 0; i < n; i++) dev += (nn[i] - mean) * (nn[i] - mean);
  const cv = Math.sqrt(dev / n) / mean;
  const drift = late / tr;

  const clumpy = cv >= 0.45 && cv <= 3.0;
  const alive = drift >= 0.0025 && drift <= 0.06;
  const stillGoing = late >= early * 0.4;
  return clumpy && alive && stillGoing;
}

function rollRules() {
  for (let attempt = 0; attempt < 15; attempt++) {
    rollMat();
    if (trialPass()) break;
    if (attempt === 14) loadKnownMatrix();
  }
  scatter();
  matrixDirty = true;
}

function render() {
  wbuf.fill(0xff000000);
  for (let i = 0; i < count; i++) {
    wbuf[(py[i] | 0) * W + (px[i] | 0)] = hex[kind[i]];
  }
  wctx.putImageData(wimg, 0, 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, sw / 2, sh / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camX, -camY);
  ctx.drawImage(worldCv, 0, 0);
  if (mouse.on) {
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, mouse.radius, 0, Math.PI * 2);
    ctx.strokeStyle = mouse.pull > 0 ? "rgba(105,219,124,0.55)" : "rgba(242,87,107,0.55)";
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();
  }
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "#1d1d24";
  ctx.strokeRect(-0.5, -0.5, W + 1, H + 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function zoomAt(sx, sy, f) {
  const nz = Math.max(0.25, Math.min(24, zoom * f));
  if (nz === zoom) return;
  // zoom around the cursor, not the top-left
  const wx = camX + (sx - sw / 2) / zoom;
  const wy = camY + (sy - sh / 2) / zoom;
  camX = wx - (sx - sw / 2) / nz;
  camY = wy - (sy - sh / 2) / nz;
  zoom = nz;
}

addEventListener("wheel", (e) => {
  // on window, not the canvas, so the wheel works over the hud too
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0013));
}, { passive: false });

stage.addEventListener("dblclick", () => {
  zoom = 1;
  camX = W / 2;
  camY = H / 2;
});

stage.addEventListener("contextmenu", (e) => e.preventDefault());

const pointers = new Map();
let pinchDist = 0;

function pinchy() {
  const pts = [...pointers.values()];
  const dx = pts[0].x - pts[1].x;
  const dy = pts[0].y - pts[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}

function setMouseWorld(cx, cy) {
  mouse.x = camX + (cx - sw / 2) / zoom;
  mouse.y = camY + (cy - sh / 2) / zoom;
}

stage.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    mouse.on = true;
    mouse.pull = e.button === 2 ? -1 : 1;
    setMouseWorld(e.clientX, e.clientY);
    if (mouse.pull > 0) {
      // gather with the left, blast with the right
      spawn(mouse.x, mouse.y, 95, 2.6);
      kick(mouse.x, mouse.y, mouse.radius * 1.8, 1.2);
    } else {
      spawn(mouse.x, mouse.y, 45, 3.2);
      kick(mouse.x, mouse.y, mouse.radius * 2.8, 7.5);
    }
  } else {
    mouse.on = false;
    pinchDist = pinchy();
  }
});

stage.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && mouse.on) {
    setMouseWorld(e.clientX, e.clientY);
  } else if (pointers.size === 2) {
    const d = pinchy();
    const pts = [...pointers.values()];
    zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, d / pinchDist);
    pinchDist = d;
  }
});

function releasePointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (pointers.size === 0) mouse.on = false;
}
stage.addEventListener("pointerup", releasePointer);
stage.addEventListener("pointercancel", releasePointer);
stage.addEventListener("pointerleave", releasePointer);

function fit() {
  sw = innerWidth;
  sh = innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  stage.width = Math.round(sw * dpr);
  stage.height = Math.round(sh * dpr);
}
addEventListener("resize", fit);

const hud = document.getElementById("hud");
document.getElementById("title").addEventListener("click", () => hud.classList.toggle("closed"));

const CELL = innerWidth < 480 ? 13 : 16;
const GAP = 3, LAB = 12;
const MSIZE = LAB + TYPES * CELL + (TYPES - 1) * GAP;
const matrix = document.getElementById("matrix");
const mctx = matrix.getContext("2d");
const readout = document.getElementById("readout");
matrix.width = MSIZE * 2;
matrix.height = MSIZE * 2;
matrix.style.width = MSIZE + "px";
matrix.style.height = MSIZE + "px";
mctx.setTransform(2, 0, 0, 2, 0, 0);

let hoverCell = null, painting = false;

function drawMatrix() {
  mctx.fillStyle = "#0b0b0e";
  mctx.fillRect(0, 0, MSIZE, MSIZE);
  for (let i = 0; i < TYPES; i++) {
    mctx.fillStyle = PALETTE[i];
    mctx.fillRect(2, LAB + i * (CELL + GAP) + (CELL - 8) / 2, 8, 8);
    mctx.fillRect(LAB + i * (CELL + GAP) + (CELL - 8) / 2, 2, 8, 8);
  }
  for (let i = 0; i < TYPES; i++) {
    for (let j = 0; j < TYPES; j++) {
      const v = mat[i * TYPES + j];
      const x = LAB + j * (CELL + GAP);
      const y = LAB + i * (CELL + GAP);
      if (v > 0.001) mctx.fillStyle = "rgba(64,214,138," + v + ")";
      else if (v < -0.001) mctx.fillStyle = "rgba(242,87,107," + (-v) + ")";
      else mctx.fillStyle = "#141419";
      mctx.fillRect(x, y, CELL, CELL);
      if (i === j) {
        mctx.strokeStyle = "rgba(255,255,255,0.14)";
        mctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
      }
    }
  }
  if (hoverCell) {
    const x = LAB + hoverCell.col * (CELL + GAP);
    const y = LAB + hoverCell.row * (CELL + GAP);
    mctx.strokeStyle = "#8a90a0";
    mctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
  }
}

function cellFromEvent(e) {
  const r = matrix.getBoundingClientRect();
  const x = e.clientX - r.left - LAB;
  const y = e.clientY - r.top - LAB;
  const col = Math.floor(x / (CELL + GAP));
  const row = Math.floor(y / (CELL + GAP));
  if (col < 0 || col >= TYPES || row < 0 || row >= TYPES) return null;
  return { row, col, yIn: y - row * (CELL + GAP) };
}

function paintAt(e) {
  const c = cellFromEvent(e);
  if (!c) return;
  const v = Math.max(-1, Math.min(1, 1 - (2 * c.yIn) / CELL));
  mat[c.row * TYPES + c.col] = v;
  matrixDirty = true;
}

matrix.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  matrix.setPointerCapture(e.pointerId);
  painting = true;
  paintAt(e);
});

matrix.addEventListener("pointermove", (e) => {
  if (painting) {
    paintAt(e);
    return;
  }
  const c = cellFromEvent(e);
  hoverCell = c;
  if (c) {
    const v = mat[c.row * TYPES + c.col];
    readout.textContent = NAMES[c.row] + (v < 0 ? " shuns " : " pulls ") + NAMES[c.col] + "  " + (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(2);
  } else {
    readout.textContent = "drag up to pull, down to shun";
  }
  matrixDirty = true;
});

matrix.addEventListener("pointerup", () => { painting = false; });
matrix.addEventListener("pointercancel", () => { painting = false; });

function togglePause() {
  paused = !paused;
  document.getElementById("btnPause").textContent = paused ? "run" : "pause";
}

document.getElementById("btnRules").addEventListener("click", (e) => { rollRules(); e.currentTarget.blur(); });
document.getElementById("btnSoup").addEventListener("click", (e) => {
  count = initCount;
  scatter();
  updateMeta();
  matrixDirty = true;
  e.currentTarget.blur();
});
document.getElementById("btnPause").addEventListener("click", (e) => { togglePause(); e.currentTarget.blur(); });
document.getElementById("btnSpeed").addEventListener("click", (e) => {
  speed = speed === 4 ? 1 : speed * 2;
  e.currentTarget.textContent = speed + "×";
  e.currentTarget.blur();
});

addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) togglePause();
  } else if (e.key === "h" || e.key === "H") {
    hud.classList.toggle("closed");
  } else if (e.key === "r" || e.key === "R") {
    rollRules();
  } else if (e.key === "n" || e.key === "N") {
    count = initCount;
    scatter();
    updateMeta();
    matrixDirty = true;
  }
});

function tick() {
  if (!paused) {
    const subs = speed * 2;
    for (let s = 0; s < subs; s++) {
      buildGrid(px, py, count, cellsX, cellsY, cellW, cellH, heads, next);
      physStep(px, py, vx, vy, kind, count, rmax, W, H, heads, next, cellsX, cellsY, cellW, cellH);
      if (mouse.on) poke();
    }
  }
  render();
  if (matrixDirty) {
    drawMatrix();
    matrixDirty = false;
  }
  requestAnimationFrame(tick);
}

function boot() {
  fit();
  sizeWorld();
  px = new Float32Array(CAP);
  py = new Float32Array(CAP);
  vx = new Float32Array(CAP);
  vy = new Float32Array(CAP);
  kind = new Uint8Array(CAP);
  heads = new Int32Array(cellsX * cellsY);
  next = new Int32Array(CAP);

  worldCv = document.createElement("canvas");
  worldCv.width = W;
  worldCv.height = H;
  wctx = worldCv.getContext("2d");
  wimg = wctx.createImageData(W, H);
  wbuf = new Uint32Array(wimg.data.buffer);

  zoom = 1;
  camX = W / 2;
  camY = H / 2;
  mouse.radius = rmax * 2.3;

  updateMeta();

  rollRules();
  requestAnimationFrame(tick);
}

boot();