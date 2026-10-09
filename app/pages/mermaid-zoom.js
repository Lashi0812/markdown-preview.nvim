/*
 * GitHub-style pan/zoom for mermaid diagrams.
 *
 * Controls (hover to reveal; always visible on touch devices):
 *   top-right     : [ fullscreen / close ]
 *   bottom-right  : [ + ] [ % ] [ - ]   and a d-pad  [ up / left / reset / right / down ]
 *                   (buttons repeat while held)
 *
 * Mouse / touch:
 *   - drag to pan (touch: horizontal drag pans, vertical drag still scrolls the page)
 *   - Ctrl/Cmd + wheel or trackpad pinch zooms at the cursor (plain wheel scrolls the page)
 *   - two-finger pinch zooms on touch screens
 *   - double-click resets
 * Fullscreen:
 *   - plain wheel zooms, Esc closes, + / - / 0 / arrow keys zoom, reset, pan
 *
 * Self-healing: a global MutationObserver re-attaches controls whenever mermaid
 * (re)renders a diagram, so late / lazy / live re-renders always get controls.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.2;
const MAX_SCALE = 12;
const ZOOM_STEP = 1.25;
const PAN_STEP = 0.2;
const WHEEL_NEEDS_MODIFIER = true;

const STYLES = `
.mermaid { position: relative; touch-action: pan-y; }
.mermaid.mmd-dragging { cursor: grabbing !important; user-select: none; }

.mmd-ctl {
	position: absolute;
	z-index: 10;
	display: flex;
	gap: 6px;
	opacity: 0;
	pointer-events: none;
	transition: opacity 0.15s ease;
}
.mermaid:hover > .mmd-ctl,
.mermaid:focus-within > .mmd-ctl,
.mermaid.mmd-fullscreen > .mmd-ctl {
	opacity: 1;
	pointer-events: auto;
}
@media (hover: none) {
	.mmd-ctl { opacity: 0.9; pointer-events: auto; }
}
.mmd-ctl-top { top: 8px; right: 8px; }
.mmd-ctl-bottom { bottom: 8px; right: 8px; align-items: flex-end; }

.mmd-col { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
.mmd-dpad {
	display: grid;
	grid-template-columns: repeat(3, 26px);
	grid-template-rows: repeat(3, 26px);
	gap: 2px;
}

.mmd-zoom-btn {
	min-width: 26px;
	height: 26px;
	padding: 0 6px;
	border: 1px solid rgba(128, 128, 128, 0.5);
	border-radius: 4px;
	background: rgba(30, 30, 30, 0.88);
	color: #e6edf3;
	font: 13px/1 "JetBrains Mono", monospace;
	cursor: pointer;
	user-select: none;
	touch-action: manipulation;
}
.mmd-zoom-btn:hover,
.mmd-zoom-btn:focus-visible {
	background: rgba(88, 166, 255, 0.3);
	border-color: #58a6ff;
	outline: none;
}
.mmd-zoom-btn:active { background: rgba(88, 166, 255, 0.5); }

.mmd-pct {
	height: 20px;
	line-height: 20px;
	text-align: center;
	font: 11px/20px "JetBrains Mono", monospace;
	color: #c9d1d9;
	background: rgba(30, 30, 30, 0.88);
	border: 1px solid rgba(128, 128, 128, 0.5);
	border-radius: 4px;
	min-width: 48px;
	user-select: none;
}

.mermaid.mmd-fullscreen {
	position: fixed !important;
	inset: 0 !important;
	width: 100vw !important;
	height: 100vh !important;
	max-width: none !important;
	margin: 0 !important;
	border: 0 !important;
	border-radius: 0 !important;
	background: #1e1e1e;
	z-index: 99998;
	cursor: grab;
	touch-action: none !important;
}
`;

// key -> { scale, tx, ty, touched }; survives live re-renders.
// Keyed by a stable data attribute so inserting/removing diagrams above
// an existing one does not shift its saved zoom state.
const views = new Map();
const teardowns = new WeakMap(); // div -> () => void  (cleanup of a previous setup)
const svgOf = new WeakMap(); // div -> the <svg> the current setup was built for
let keyCounter = 0;

// The diagram that is currently fullscreen, tracked by node reference so a
// re-render (which replaces the div) can be detected and cleaned up.
let activeFs = null; // { div, exit, zoomCenter, reset, panByPx, step }
let keysBound = false;
let observerBound = false;
let scheduled = false;

function keyOf(div) {
  let k = div.dataset.mmdKey;
  if (!k) {
    k = `mmd-${++keyCounter}`;
    div.dataset.mmdKey = k;
  }
  return k;
}

function ensureStyles() {
  if (document.getElementById('mmd-zoom-styles')) return;
  const style = document.createElement('style');
  style.id = 'mmd-zoom-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function bindGlobalKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!activeFs) return;
    // Esc always closes fullscreen, regardless of focus. Handle before the
    // editable-target guard so a focused preview body can't swallow it.
    if (e.key === 'Escape') {
      e.preventDefault();
      activeFs.exit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      e.target.isContentEditable ||
      /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)
    )
      return;
    const s = activeFs.step();
    switch (e.key) {
      case '+':
      case '=':
        activeFs.zoomCenter(ZOOM_STEP);
        break;
      case '-':
      case '_':
        activeFs.zoomCenter(1 / ZOOM_STEP);
        break;
      case '0':
        activeFs.reset();
        break;
      case 'ArrowUp':
        activeFs.panByPx(0, s);
        break;
      case 'ArrowDown':
        activeFs.panByPx(0, -s);
        break;
      case 'ArrowLeft':
        activeFs.panByPx(s, 0);
        break;
      case 'ArrowRight':
        activeFs.panByPx(-s, 0);
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}

// Watch the whole document: any time mermaid adds / replaces a diagram, re-run attach.
// attach is idempotent, so our own DOM changes converge after one extra no-op pass.
function scheduleAttach() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    attachMermaidZoom();
  });
}

function bindObserver() {
  if (observerBound || !document.body) return;
  observerBound = true;
  new MutationObserver((muts) => {
    // ignore churn from our own controls (e.g. the % label updating while panning)
    const relevant = muts.some(
      (m) => !(m.target.closest && m.target.closest('.mmd-ctl'))
    );
    if (relevant) scheduleAttach();
  }).observe(document.body, { childList: true, subtree: true });
}

function mkBtn(label, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mmd-zoom-btn';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

// click + hold-to-repeat, keyboard (Enter/Space) friendly.
// Returns a cleanup fn so pending timers are cleared on teardown.
function onPress(btn, fn, repeat = true) {
  let delay = null;
  let timer = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(timer);
    delay = null;
    timer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    fn();
    if (repeat)
      delay = setTimeout(() => {
        timer = setInterval(fn, 80);
      }, 350);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) =>
    btn.addEventListener(t, stop)
  );
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  });
  return stop;
}

function setup(div, svg, index) {
  // Remove anything left over from a previous setup of this div (stale controls,
  // duplicate listeners, orphaned fullscreen placeholder).
  const prev = teardowns.get(div);
  if (prev) prev();
  div.querySelectorAll(':scope > .mmd-ctl').forEach((n) => n.remove());

  const ac = new AbortController();
  const opts = { signal: ac.signal };
  const stopTimers = [];

  // Wrap mermaid's svg children so we can transform without touching its attributes.
  let g = svg.querySelector(':scope > g.mmd-pan');
  if (!g) {
    g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('mmd-pan');
    while (svg.firstChild) g.appendChild(svg.firstChild);
    svg.appendChild(g);
  }

  const key = keyOf(div);
  const saved = views.get(key);
  let scale = saved ? saved.scale : 1;
  let tx = saved ? saved.tx : 0;
  let ty = saved ? saved.ty : 0;
  let touched = saved ? saved.touched : false;

  // ---------- controls ----------
  const ctlTop = document.createElement('div');
  ctlTop.className = 'mmd-ctl mmd-ctl-top';
  const btnFull = mkBtn('⤢', 'Fullscreen');
  ctlTop.appendChild(btnFull);

  const ctlBottom = document.createElement('div');
  ctlBottom.className = 'mmd-ctl mmd-ctl-bottom';
  const col = document.createElement('div');
  col.className = 'mmd-col';
  const btnIn = mkBtn('+', 'Zoom in');
  const pct = document.createElement('div');
  pct.className = 'mmd-pct';
  const btnOut = mkBtn('−', 'Zoom out');
  col.append(btnIn, pct, btnOut);

  const dpad = document.createElement('div');
  dpad.className = 'mmd-dpad';
  const btnUp = mkBtn('▲', 'Pan up');
  const btnLeft = mkBtn('◀', 'Pan left');
  const btnReset = mkBtn('⟲', 'Reset view');
  const btnRight = mkBtn('▶', 'Pan right');
  const btnDown = mkBtn('▼', 'Pan down');
  btnUp.style.gridArea = '1 / 2';
  btnLeft.style.gridArea = '2 / 1';
  btnReset.style.gridArea = '2 / 2';
  btnRight.style.gridArea = '2 / 3';
  btnDown.style.gridArea = '3 / 2';
  dpad.append(btnUp, btnLeft, btnReset, btnRight, btnDown);
  ctlBottom.append(col, dpad);
  div.append(ctlTop, ctlBottom);

  // ---------- geometry helpers ----------
  const pxPerUnit = () => {
    const m = svg.getScreenCTM();
    return m && m.a ? m.a : 1;
  };
  const step = () => Math.min(div.clientWidth, div.clientHeight) * PAN_STEP;

  const toLocal = (clientX, clientY) => {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const apply = () => {
    g.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
    pct.textContent = `${Math.round(scale * pxPerUnit() * 100)}%`;
    views.set(key, { scale, tx, ty, touched });
  };

  const fit = () => {
    const k = pxPerUnit();
    // Inline: never upscale past 100%. Fullscreen: scale up to fill the screen.
    const s = div.classList.contains('mmd-fullscreen') ? 1 / k : (k > 1 ? 1 / k : 1);
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const cx = vb && vb.width ? vb.x + vb.width / 2 : 0;
    const cy = vb && vb.height ? vb.y + vb.height / 2 : 0;
    scale = s;
    tx = cx * (1 - s);
    ty = cy * (1 - s);
  };

  // Size the box to the diagram (natural size, capped to 85% of the window).
  // Forces a synchronous layout so the CTM read by a following fit() is accurate.
  let lastW = 0;
  const sizeBox = () => {
    if (div.classList.contains('mmd-fullscreen')) return;
    const w = div.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) return;
    const natural = vb.height * Math.min(1, w / vb.width);
    const h = Math.round(
      Math.min(Math.max(natural + 32, 160), window.innerHeight * 0.85)
    );
    div.style.height = `${h}px`;
    // Flush layout so a synchronous getScreenCTM() sees the new size.
    void div.offsetHeight;
  };

  const reset = () => {
    touched = false;
    fit();
    apply();
  };

  const zoomAt = (clientX, clientY, factor) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (next === scale) return;
    const l = toLocal(clientX, clientY);
    tx = l.x - ((l.x - tx) / scale) * next;
    ty = l.y - ((l.y - ty) / scale) * next;
    scale = next;
    touched = true;
    apply();
  };

  const zoomCenter = (factor) => {
    const r = div.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };

  const panByPx = (dx, dy) => {
    const k = pxPerUnit();
    tx += dx / k;
    ty += dy / k;
    touched = true;
    apply();
  };

  // ---------- fullscreen ----------
  let placeholder = null;
  const enter = () => {
    if (div.classList.contains('mmd-fullscreen')) return;
    placeholder = document.createElement('div');
    placeholder.style.height = `${div.offsetHeight}px`;
    div.before(placeholder);
    div.classList.add('mmd-fullscreen');
    document.documentElement.style.overflow = 'hidden';
    btnFull.textContent = '✕';
    btnFull.title = 'Close fullscreen (Esc)';
    activeFs = { div, exit, zoomCenter, reset, panByPx, step };
    // fresh fit so the diagram fills the screen (upscale allowed in fs)
    if (!touched) fit();
    apply();
  };
  function exit() {
    div.classList.remove('mmd-fullscreen');
    if (placeholder) placeholder.remove();
    placeholder = null;
    document.documentElement.style.overflow = '';
    btnFull.textContent = '⤢';
    btnFull.title = 'Fullscreen';
    if (activeFs && activeFs.div === div) activeFs = null;
    // back to natural size: refit at 100% and restore the box height
    fit();
    apply();
    lastW = 0;
    sizeBox();
  }
  const toggleFullscreen = () =>
    div.classList.contains('mmd-fullscreen') ? exit() : enter();

  // ---------- wire up buttons ----------
  stopTimers.push(onPress(btnIn, () => zoomCenter(ZOOM_STEP)));
  stopTimers.push(onPress(btnOut, () => zoomCenter(1 / ZOOM_STEP)));
  stopTimers.push(onPress(btnUp, () => panByPx(0, step())));
  stopTimers.push(onPress(btnDown, () => panByPx(0, -step())));
  stopTimers.push(onPress(btnLeft, () => panByPx(step(), 0)));
  stopTimers.push(onPress(btnRight, () => panByPx(-step(), 0)));
  stopTimers.push(onPress(btnReset, reset, false));
  stopTimers.push(onPress(btnFull, toggleFullscreen, false));

  // ---------- wheel / pinch ----------
  div.addEventListener(
    'wheel',
    (e) => {
      const inFs = div.classList.contains('mmd-fullscreen');
      const mod = e.ctrlKey || e.metaKey;
      if (WHEEL_NEEDS_MODIFIER && !inFs && !mod) return;
      // Trackpad pinch on macOS reports ctrlKey on a plain wheel event with a
      // usually-fractional, small deltaY. Only treat it as a zoom if the
      // pointer is actually over this diagram, so it can't hijack scroll.
      if (!inFs && mod && !div.matches(':hover')) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    },
    { passive: false, signal: ac.signal }
  );

  // ---------- drag to pan + two-finger pinch ----------
  const ptrs = new Map();
  let lastDist = 0;
  let lastCx = 0;
  let lastCy = 0;
  const pinchState = () => {
    const [a, b] = [...ptrs.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  };

  div.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target.closest('.mmd-ctl')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        div.setPointerCapture(e.pointerId);
      } catch (_) {}
      div.classList.add('mmd-dragging');
      if (ptrs.size === 2) {
        const s = pinchState();
        lastDist = s.dist;
        lastCx = s.cx;
        lastCy = s.cy;
      }
      if (e.pointerType === 'mouse') e.preventDefault();
    },
    opts
  );

  div.addEventListener(
    'pointermove',
    (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptrs.size === 1) {
        panByPx(dx, dy);
      } else if (ptrs.size === 2) {
        const s = pinchState();
        if (lastDist) zoomAt(s.cx, s.cy, s.dist / lastDist);
        panByPx(s.cx - lastCx, s.cy - lastCy);
        lastDist = s.dist;
        lastCx = s.cx;
        lastCy = s.cy;
      }
    },
    opts
  );

  const endPointer = (e) => {
    ptrs.delete(e.pointerId);
    lastDist = 0;
    if (!ptrs.size) div.classList.remove('mmd-dragging');
  };
  div.addEventListener('pointerup', endPointer, opts);
  div.addEventListener('pointercancel', endPointer, opts);

  div.addEventListener(
    'dblclick',
    (e) => {
      if (!e.target.closest('.mmd-ctl')) reset();
    },
    opts
  );

  // Keep "fit" correct when the box resizes (window resize, fullscreen toggle, un-hiding)
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      sizeBox();
      if (!touched) fit();
      apply();
    });
    ro.observe(div);
  }

  // ---------- teardown (used when this diagram is re-rendered / re-setup) ----------
  teardowns.set(div, () => {
    ac.abort();
    stopTimers.forEach((f) => f());
    if (ro) ro.disconnect();
    div.classList.remove('mmd-dragging');
    if (div.classList.contains('mmd-fullscreen')) {
      div.classList.remove('mmd-fullscreen');
      if (placeholder) placeholder.remove();
      placeholder = null;
      if (activeFs && activeFs.div === div) activeFs = null;
      document.documentElement.style.overflow = '';
    }
    ctlTop.remove();
    ctlBottom.remove();
    teardowns.delete(div);
    svgOf.delete(div);
  });
  svgOf.set(div, svg);

  // ---------- initial state ----------
  // sizeBox() writes style.height; getScreenCTM() lags that by a layout pass,
  // so fit() synchronously after it reads a stale ratio. Defer the first fit
  // to rAF (post-layout) so a plain refresh doesn't produce a mis-scaled view.
  sizeBox();
  if (!saved || !saved.touched) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        // Bail if this diagram was re-rendered before the frame landed.
        if (teardowns.get(div) && !touched) {
          fit();
          apply();
        }
      });
    } else {
      fit();
      apply();
    }
  } else {
    apply();
  }
  if (activeFs && activeFs.div === div) enter();
}

// A diagram is "healthy" if it was set up for its current <svg> and its controls are still there.
function isHealthy(div, svg) {
  return (
    teardowns.has(div) &&
    svgOf.get(div) === svg &&
    !!div.querySelector(':scope > .mmd-ctl') &&
    !!svg.querySelector(':scope > g.mmd-pan')
  );
}

function attachMermaidZoom() {
  ensureStyles();
  bindGlobalKeys();
  bindObserver();

  // If the fullscreen diagram was replaced (re-render / block deleted), release
  // the page-scroll lock and drop the stale reference. Without this the page
  // stays unscrollable after an edit that removes or breaks the fs diagram.
  if (activeFs && !activeFs.div.isConnected) {
    document.documentElement.style.overflow = '';
    activeFs = null;
  }

  const divs = document.querySelectorAll('.mermaid');

  divs.forEach((div, index) => {
    const svg = div.querySelector('svg');
    // Not rendered yet: the global MutationObserver will call us again when it lands.
    if (!svg) return;
    if (isHealthy(div, svg)) return;
    try {
      setup(div, svg, index);
    } catch (e) {
      console.error('mermaid-zoom setup failed for diagram', index, e);
    }
  });
}

export default attachMermaidZoom;
