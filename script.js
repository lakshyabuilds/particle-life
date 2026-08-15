"use strict";

var stage = document.getElementById("stage");
var ctx = stage.getContext("2d");

var TYPES = 7;
var NAMES = ["rose", "orange", "yellow", "green", "cyan", "blue", "violet"];
var PALETTE = ["#ff4d6d", "#ffa94d", "#ffe066", "#69db7c", "#3bc9db", "#748ffc", "#e599f7"];

// abgr packed, written straight into the pixel buffer
var hex = PALETTE.map(function(h) {
  var r = parseInt(h.slice(1, 3), 16);
  var g = parseInt(h.slice(3, 5), 16);
  var b = parseInt(h.slice(5, 7), 16);
  return (0xff << 24) | (b << 16) | (g << 8) | r;
});

var FRICTION = 0.80;
var FORCE = 0.14;
var CURSOR = 0.09;
var CAP = 20000;

var sw = innerWidth, sh = innerHeight;
var W, H, count, initCount, rmax, cellsX, cellsY, cellW, cellH;
var px, py, vx, vy, kind;
var heads, next;
var mat = new Float32Array(TYPES * TYPES);

var worldCv, wctx, wimg, wbuf;
var zoom = 1, camX, camY;
var paused = false, speed = 1;
var matrixDirty = true;
var mouse = { on: false, x: 0, y: 0, radius: 0, pull: 1 };


function sizeWorld() {
  W = Math.min(innerWidth, 2560);
  H = Math.min(innerHeight, 1440);
  initCount = Math.max(1200, Math.min(9000, Math.round((W * H) / 160)));
  count = initCount;
  rmax = Math.min(105, Math.max(30, Math.sqrt((W * H) / count) * 3.2));
  // grid needs >=3 cells per axis or edge neighbours get missed
  rmax = Math.min(rmax, W / 3, H / 3);
  cellsX = Math.max(3, Math.floor(W / rmax));
  cellsY = Math.max(3, Math.floor(H / rmax));
  cellW = W / cellsX;
  cellH = H / cellsY;
}

function updateMeta() {
  document.getElementById("meta").textContent =
    TYPES + " colours · " + count.toLocaleString() + " beings" + (count >= CAP ? " · full" : "");
}

function scatter() {
  for (var i = 0; i < count; i++) {
    px[i] = Math.random() * W;
    py[i] = Math.random() * H;
    vx[i] = 0;
    vy[i] = 0;
    kind[i] = (Math.random() * TYPES) | 0;
  }
}

function rollMat() {
  // mixed diagonal: some colours form tight membranes, others stay fluid
  for (var i = 0; i < TYPES; i++) {
    for (var j = 0; j < TYPES; j++) {
      if (i === j) {
        // even indices clump, odd ones float
        mat[i * TYPES + j] = (i % 2 === 0)
          ? 0.38 + Math.random() * 0.32
          : 0.05 + Math.random() * 0.25;
      } else if ((i + 1) % TYPES === j) {
        mat[i * TYPES + j] = 0.22 + Math.random() * 0.28;
      } else if ((i + TYPES - 1) % TYPES === j) {
        mat[i * TYPES + j] = -0.32 - Math.random() * 0.28;
      } else {
        var draw = Math.random();
        if (draw < 0.35) mat[i * TYPES + j] = 0.0;
        else if (draw < 0.65) mat[i * TYPES + j] = -0.25 - Math.random() * 0.25;
        else mat[i * TYPES + j] = 0.10 + Math.random() * 0.18;
      }
    }
  }
}

function loadKnownMatrix() {
  mat.fill(0);
  var i;
  for (i = 0; i < TYPES; i++) mat[i * TYPES + i] = (i % 2 === 0) ? 0.52 : 0.22;
  var walls = [
    [0,2,-0.38],[0,4,-0.42],[0,6,-0.35],
    [1,3,-0.40],[1,5,-0.45],
    [2,4,-0.35],[2,6,-0.38],
    [3,5,-0.42],[4,6,-0.40]
  ];
  for (i = 0; i < walls.length; i++) mat[walls[i][0]*TYPES+walls[i][1]] = walls[i][2];
  mat[0*TYPES+1]=0.38; mat[1*TYPES+2]=0.35; mat[2*TYPES+3]=0.36;
  mat[3*TYPES+4]=0.34; mat[4*TYPES+5]=0.37; mat[5*TYPES+6]=0.33; mat[6*TYPES+0]=0.35;
  mat[0*TYPES+3]=0.0; mat[1*TYPES+4]=0.0; mat[2*TYPES+5]=0.0;
  mat[3*TYPES+6]=0.0; mat[4*TYPES+0]=0.0; mat[5*TYPES+1]=0.0;
}

function buildGrid(xs, ys, n, cw, ch, cwid, chei, hs, nx) {
  hs.fill(0);
  for (var i = 0; i < n; i++) {
    var cx = Math.min((xs[i] / cwid) | 0, cw - 1);
    var cy = Math.min((ys[i] / chei) | 0, ch - 1);
    nx[i] = hs[cy * cw + cx];
    hs[cy * cw + cx] = i + 1;
  }
}

function physStep(xs, ys, vxs, vys, ks, n, rm, w, h, hs, nx, cw, ch, cwid, chei) {
  var rr = rm * rm;
  var rmin = rm * 0.28;
  var inv = 1 / (rm - rmin);
  var cap = rm / 8;
  var halfW = w * 0.5, halfH = h * 0.5;
  for (var i = 0; i < n; i++) {
    var xi = xs[i], yi = ys[i], ti = ks[i];
    var fx = 0, fy = 0;
    var cx = Math.min((xi / cwid) | 0, cw - 1);
    var cy = Math.min((yi / chei) | 0, ch - 1);
    for (var oy = -1; oy <= 1; oy++) {
      var gy = cy + oy;
      if (gy < 0) gy += ch; else if (gy >= ch) gy -= ch;
      for (var ox = -1; ox <= 1; ox++) {
        var gx = cx + ox;
        if (gx < 0) gx += cw; else if (gx >= cw) gx -= cw;
        var e = hs[gy * cw + gx];
        while (e) {
          var b = e - 1;
          e = nx[b];
          if (b === i) continue;
          var dx = xs[b] - xi, dy = ys[b] - yi;
          if (dx > halfW) dx -= w; else if (dx < -halfW) dx += w;
          if (dy > halfH) dy -= h; else if (dy < -halfH) dy += h;
          var d2 = dx * dx + dy * dy;
          if (d2 >= rr || d2 < 1e-6) continue;
          var d = Math.sqrt(d2);
          var f;
          if (d < rmin) {
            f = d / rmin - 1;
          } else {
            f = mat[ti * TYPES + ks[b]] * (1 - Math.abs(2 * d - rmin - rm) * inv);
          }
          var s = f / d;
          fx += dx * s;
          fy += dy * s;
        }
      }
    }
    var nvx = (vxs[i] + fx * FORCE) * FRICTION;
    var nvy = (vys[i] + fy * FORCE) * FRICTION;
    var sp = Math.sqrt(nvx * nvx + nvy * nvy);
    if (sp > cap) { nvx = (nvx / sp) * cap; nvy = (nvy / sp) * cap; }
    vxs[i] = nvx; vys[i] = nvy;
    var nxp = xi + nvx, nyp = yi + nvy;
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
  var R = mouse.radius, R2 = R * R;
  var ax = mouse.x, ay = mouse.y;
  var k = CURSOR * mouse.pull;
  for (var i = 0; i < count; i++) {
    var dx = wrapDX(ax - px[i]), dy = wrapDY(ay - py[i]);
    var d2 = dx * dx + dy * dy;
    if (d2 >= R2) continue;
    var d = Math.sqrt(d2) || 1;
    var f = (1 - d / R) * k;
    vx[i] += (dx / d) * f;
    vy[i] += (dy / d) * f;
  }
}

function kick(ax, ay, rad, str) {
  var r2 = rad * rad;
  for (var i = 0; i < count; i++) {
    var dx = wrapDX(px[i] - ax), dy = wrapDY(py[i] - ay);
    var d2 = dx * dx + dy * dy;
    if (d2 >= r2 || d2 < 1e-6) continue;
    var d = Math.sqrt(d2);
    var f = (1 - d / rad) * str;
    vx[i] += (dx / d) * f;
    vy[i] += (dy / d) * f;
  }
}

function spawn(ax, ay, n, burst) {
  if (count >= CAP) return;
  var can = Math.min(n, CAP - count);
  var R = mouse.radius * 0.75;
  for (var k = 0; k < can; k++) {
    var idx = count + k;
    var ang = Math.random() * 6.2831853;
    var rad = Math.random() * R * 0.65;
    var cx = (ax + Math.cos(ang) * rad) % W;
    var cy = (ay + Math.sin(ang) * rad) % H;
    if (cx < 0) cx += W;
    if (cy < 0) cy += H;
    px[idx] = cx;
    py[idx] = cy;
    var out = burst * (0.4 + Math.random() * 0.9);
    vx[idx] = Math.cos(ang) * out + (Math.random() - 0.5) * 0.7;
    vy[idx] = Math.sin(ang) * out + (Math.random() - 0.5) * 0.7;
    kind[idx] = (Math.random() * TYPES) | 0;
  }
  count += can;
  updateMeta();
}

function trialPass() {
  var n = 320, tw = 420, th = 420;
  var tr = Math.sqrt((tw * th) / n) * 3.2;
  var tcx = Math.max(3, Math.floor(tw / tr)), tcy = Math.max(3, Math.floor(th / tr));
  var tcw = tw / tcx, tch = th / tcy;
  var theads = new Int32Array(tcx * tcy);
  var tnext = new Int32Array(n);
  var tx = new Float32Array(n), ty = new Float32Array(n);
  var tvx = new Float32Array(n), tvy = new Float32Array(n);
  var tk = new Uint8Array(n);
  var i, s;
  for (i = 0; i < n; i++) {
    tx[i] = Math.random() * tw;
    ty[i] = Math.random() * th;
    tvx[i] = 0; tvy[i] = 0;
    tk[i] = (Math.random() * TYPES) | 0;
  }
  for (s = 0; s < 240; s++) {
    buildGrid(tx, ty, n, tcx, tcy, tcw, tch, theads, tnext);
    physStep(tx, ty, tvx, tvy, tk, n, tr, tw, th, theads, tnext, tcx, tcy, tcw, tch);
  }
  var es = 0;
  for (i = 0; i < n; i++) es += Math.sqrt(tvx[i] * tvx[i] + tvy[i] * tvy[i]);
  var early = es / n;

  for (s = 0; s < 140; s++) {
    buildGrid(tx, ty, n, tcx, tcy, tcw, tch, theads, tnext);
    physStep(tx, ty, tvx, tvy, tk, n, tr, tw, th, theads, tnext, tcx, tcy, tcw, tch);
  }
  var ls = 0;
  for (i = 0; i < n; i++) ls += Math.sqrt(tvx[i] * tvx[i] + tvy[i] * tvy[i]);
  var late = ls / n;

  var half = tr * 0.55, half2 = half * half;
  var hw = tw * 0.5, hh = th * 0.5;
  var nn = new Float32Array(n);
  var sum = 0;
  for (i = 0; i < n; i++) {
    var c = 0;
    for (var j = 0; j < n; j++) {
      if (j === i) continue;
      var dx = tx[j] - tx[i], dy = ty[j] - ty[i];
      if (dx > hw) dx -= tw; else if (dx < -hw) dx += tw;
      if (dy > hh) dy -= th; else if (dy < -hh) dy += th;
      if (dx * dx + dy * dy < half2) c++;
    }
    nn[i] = c;
    sum += c;
  }
  var mean = sum / n;
  if (mean <= 0) return false;
  var dev = 0;
  for (i = 0; i < n; i++) dev += (nn[i] - mean) * (nn[i] - mean);
  var cv = Math.sqrt(dev / n) / mean;
  var drift = late / tr;

  return cv >= 0.45 && cv <= 3.0
      && drift >= 0.0025 && drift <= 0.06
      && late >= early * 0.4;
}

function rollRules() {
  for (var attempt = 0; attempt < 15; attempt++) {
    rollMat();
    if (trialPass()) break;
    if (attempt === 14) loadKnownMatrix();
  }
  scatter();
  matrixDirty = true;
}


function render() {
  wbuf.fill(0xff000000);
  for (var i = 0; i < count; i++) {
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
  var nz = Math.max(0.25, Math.min(24, zoom * f));
  if (nz === zoom) return;
  var wx = camX + (sx - sw / 2) / zoom;
  var wy = camY + (sy - sh / 2) / zoom;
  camX = wx - (sx - sw / 2) / nz;
  camY = wy - (sy - sh / 2) / nz;
  zoom = nz;
}

addEventListener("wheel", function(e) {
  e.preventDefault();
  var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0013));
}, { passive: false });

stage.addEventListener("dblclick", function() {
  zoom = 1; camX = W / 2; camY = H / 2;
});
stage.addEventListener("contextmenu", function(e) { e.preventDefault(); });


var pointers = new Map();
var pinchDist = 0;

function pinchy() {
  var pts = Array.from(pointers.values());
  var dx = pts[0].x - pts[1].x;
  var dy = pts[0].y - pts[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}

function setMouseWorld(cx, cy) {
  mouse.x = camX + (cx - sw / 2) / zoom;
  mouse.y = camY + (cy - sh / 2) / zoom;
}

stage.addEventListener("pointerdown", function(e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    mouse.on = true;
    mouse.pull = e.button === 2 ? -1 : 1;
    setMouseWorld(e.clientX, e.clientY);
    if (mouse.pull > 0) {
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

stage.addEventListener("pointermove", function(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && mouse.on) {
    setMouseWorld(e.clientX, e.clientY);
  } else if (pointers.size === 2) {
    var d = pinchy();
    var pts = Array.from(pointers.values());
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
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  stage.width = Math.round(sw * dpr);
  stage.height = Math.round(sh * dpr);
}
addEventListener("resize", fit);


var hud = document.getElementById("hud");
document.getElementById("title").addEventListener("click", function() {
  hud.classList.toggle("closed");
});

var CELL = innerWidth < 480 ? 13 : 16;
var GAP = 3, LAB = 12;
var MSIZE = LAB + TYPES * CELL + (TYPES - 1) * GAP;
var matCanvas = document.getElementById("matrix");
var mctx = matCanvas.getContext("2d");
var readout = document.getElementById("readout");
matCanvas.width = MSIZE * 2;
matCanvas.height = MSIZE * 2;
matCanvas.style.width = MSIZE + "px";
matCanvas.style.height = MSIZE + "px";
mctx.setTransform(2, 0, 0, 2, 0, 0);

var hoverCell = null, painting = false;

function drawMatrix() {
  mctx.fillStyle = "#0b0b0e";
  mctx.fillRect(0, 0, MSIZE, MSIZE);
  for (var i = 0; i < TYPES; i++) {
    mctx.fillStyle = PALETTE[i];
    mctx.fillRect(2, LAB + i * (CELL + GAP) + (CELL - 8) / 2, 8, 8);
    mctx.fillRect(LAB + i * (CELL + GAP) + (CELL - 8) / 2, 2, 8, 8);
  }
  for (var i = 0; i < TYPES; i++) {
    for (var j = 0; j < TYPES; j++) {
      var v = mat[i * TYPES + j];
      var x = LAB + j * (CELL + GAP);
      var y = LAB + i * (CELL + GAP);
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
    var x = LAB + hoverCell.col * (CELL + GAP);
    var y = LAB + hoverCell.row * (CELL + GAP);
    mctx.strokeStyle = "#8a90a0";
    mctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
  }
}

function cellFromEvent(e) {
  var r = matCanvas.getBoundingClientRect();
  var x = e.clientX - r.left - LAB;
  var y = e.clientY - r.top - LAB;
  var col = Math.floor(x / (CELL + GAP));
  var row = Math.floor(y / (CELL + GAP));
  if (col < 0 || col >= TYPES || row < 0 || row >= TYPES) return null;
  return { row: row, col: col, yIn: y - row * (CELL + GAP) };
}

function paintAt(e) {
  var c = cellFromEvent(e);
  if (!c) return;
  mat[c.row * TYPES + c.col] = Math.max(-1, Math.min(1, 1 - (2 * c.yIn) / CELL));
  matrixDirty = true;
}

matCanvas.addEventListener("pointerdown", function(e) {
  e.preventDefault();
  matCanvas.setPointerCapture(e.pointerId);
  painting = true;
  paintAt(e);
});

matCanvas.addEventListener("pointermove", function(e) {
  if (painting) { paintAt(e); return; }
  var c = cellFromEvent(e);
  hoverCell = c;
  if (c) {
    var v = mat[c.row * TYPES + c.col];
    readout.textContent = NAMES[c.row] + (v < 0 ? " shuns " : " pulls ") + NAMES[c.col]
      + "  " + (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(2);
  } else {
    readout.textContent = "drag up to pull, down to shun";
  }
  matrixDirty = true;
});

matCanvas.addEventListener("pointerup", function() { painting = false; });
matCanvas.addEventListener("pointercancel", function() { painting = false; });


function togglePause() {
  paused = !paused;
  document.getElementById("btnPause").textContent = paused ? "run" : "pause";
}

document.getElementById("btnRules").addEventListener("click", function(e) {
  rollRules(); e.currentTarget.blur();
});
document.getElementById("btnSoup").addEventListener("click", function(e) {
  count = initCount; scatter(); updateMeta(); matrixDirty = true; e.currentTarget.blur();
});
document.getElementById("btnPause").addEventListener("click", function(e) {
  togglePause(); e.currentTarget.blur();
});
document.getElementById("btnSpeed").addEventListener("click", function(e) {
  speed = speed === 4 ? 1 : speed * 2;
  e.currentTarget.textContent = speed + "\u00d7";
  e.currentTarget.blur();
});

addEventListener("keydown", function(e) {
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) togglePause(); }
  else if (e.key === "h" || e.key === "H") hud.classList.toggle("closed");
  else if (e.key === "r" || e.key === "R") rollRules();
  else if (e.key === "n" || e.key === "N") {
    count = initCount; scatter(); updateMeta(); matrixDirty = true;
  }
});


function tick() {
  if (!paused) {
    var subs = speed * 2;
    for (var s = 0; s < subs; s++) {
      buildGrid(px, py, count, cellsX, cellsY, cellW, cellH, heads, next);
      physStep(px, py, vx, vy, kind, count, rmax, W, H, heads, next, cellsX, cellsY, cellW, cellH);
      if (mouse.on) poke();
    }
  }
  render();
  if (matrixDirty) { drawMatrix(); matrixDirty = false; }
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
