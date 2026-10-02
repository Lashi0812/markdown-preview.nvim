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
 * The svg is fitted into its box (never upscaled beyond 100%); "reset" returns to
 * that fit. Zoom is applied as a transform on a <g> wrapper, so the layout box
 * stays put and sync-scroll anchors keep working. View state (and fullscreen)
 * survives live re-renders from the editor.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const MIN_SCALE = 0.2
const MAX_SCALE = 12
const ZOOM_STEP = 1.25
const PAN_STEP = 0.2 // fraction of the viewport per d-pad click
const WHEEL_NEEDS_MODIFIER = true // inline: Ctrl/Cmd+wheel to zoom, so page scroll still works

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
`

// index -> { scale, tx, ty, touched }; survives live re-renders
const views = new Map()
const pending = new WeakSet()
let fsIndex = null // index of the diagram that is fullscreen (re-entered after re-render)
let activeFs = null // { div, exit, zoomCenter, reset, panByPx, step }
let keysBound = false

function ensureStyles() {
  if (document.getElementById('mmd-zoom-styles')) return
  const style = document.createElement('style')
  style.id = 'mmd-zoom-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

function bindGlobalKeys() {
  if (keysBound) return
  keysBound = true
  document.addEventListener('keydown', (e) => {
    if (!activeFs) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
    const s = activeFs.step()
    switch (e.key) {
      case 'Escape': activeFs.exit(); break
      case '+': case '=': activeFs.zoomCenter(ZOOM_STEP); break
      case '-': case '_': activeFs.zoomCenter(1 / ZOOM_STEP); break
      case '0': activeFs.reset(); break
      case 'ArrowUp': activeFs.panByPx(0, s); break
      case 'ArrowDown': activeFs.panByPx(0, -s); break
      case 'ArrowLeft': activeFs.panByPx(s, 0); break
      case 'ArrowRight': activeFs.panByPx(-s, 0); break
      default: return
    }
    e.preventDefault()
  })
}

function mkBtn(label, title) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'mmd-zoom-btn'
  b.textContent = label
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

// click + hold-to-repeat, keyboard (Enter/Space) friendly
function onPress(btn, fn, repeat = true) {
  let delay = null
  let timer = null
  const stop = () => {
    clearTimeout(delay)
    clearInterval(timer)
  }
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.stopPropagation()
    fn()
    if (repeat) delay = setTimeout(() => { timer = setInterval(fn, 80) }, 350)
  })
  ;['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, stop))
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  })
}

function setup(div, svg, index) {
  div.dataset.zoomReady = 'true'

  // Wrap mermaid's svg children so we can transform without touching its attributes
  const g = document.createElementNS(SVG_NS, 'g')
  while (svg.firstChild) g.appendChild(svg.firstChild)
  svg.appendChild(g)

  const saved = views.get(index)
  let scale = saved ? saved.scale : 1
  let tx = saved ? saved.tx : 0
  let ty = saved ? saved.ty : 0
  let touched = saved ? saved.touched : false

  // ---------- controls ----------
  const ctlTop = document.createElement('div')
  ctlTop.className = 'mmd-ctl mmd-ctl-top'
  const btnFull = mkBtn('⤢', 'Fullscreen')
  ctlTop.appendChild(btnFull)

  const ctlBottom = document.createElement('div')
  ctlBottom.className = 'mmd-ctl mmd-ctl-bottom'
  const col = document.createElement('div')
  col.className = 'mmd-col'
  const btnIn = mkBtn('+', 'Zoom in')
  const pct = document.createElement('div')
  pct.className = 'mmd-pct'
  const btnOut = mkBtn('−', 'Zoom out')
  col.append(btnIn, pct, btnOut)

  const dpad = document.createElement('div')
  dpad.className = 'mmd-dpad'
  const btnUp = mkBtn('▲', 'Pan up')
  const btnLeft = mkBtn('◀', 'Pan left')
  const btnReset = mkBtn('⟲', 'Reset view')
  const btnRight = mkBtn('▶', 'Pan right')
  const btnDown = mkBtn('▼', 'Pan down')
  btnUp.style.gridArea = '1 / 2'
  btnLeft.style.gridArea = '2 / 1'
  btnReset.style.gridArea = '2 / 2'
  btnRight.style.gridArea = '2 / 3'
  btnDown.style.gridArea = '3 / 2'
  dpad.append(btnUp, btnLeft, btnReset, btnRight, btnDown)
  ctlBottom.append(col, dpad)
  div.append(ctlTop, ctlBottom)

  // ---------- geometry helpers ----------
  const pxPerUnit = () => {
    const m = svg.getScreenCTM()
    return m && m.a ? m.a : 1
  }
  const step = () => Math.min(div.clientWidth, div.clientHeight) * PAN_STEP

  // Client-space point -> svg local (viewBox) space
  const toLocal = (clientX, clientY) => {
    const m = svg.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const p = pt.matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }

  const apply = () => {
    g.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`)
    pct.textContent = `${Math.round(scale * pxPerUnit() * 100)}%`
    views.set(index, { scale, tx, ty, touched })
  }

  // Fit = diagram centered in the box, never upscaled beyond 100%
  const fit = () => {
    const k = pxPerUnit()
    const s = k > 1 ? 1 / k : 1
    const vb = svg.viewBox && svg.viewBox.baseVal
    const cx = vb && vb.width ? vb.x + vb.width / 2 : 0
    const cy = vb && vb.height ? vb.y + vb.height / 2 : 0
    scale = s
    tx = cx * (1 - s)
    ty = cy * (1 - s)
  }

  const reset = () => {
    touched = false
    fit()
    apply()
  }

  const zoomAt = (clientX, clientY, factor) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
    if (next === scale) return
    const l = toLocal(clientX, clientY)
    tx = l.x - ((l.x - tx) / scale) * next
    ty = l.y - ((l.y - ty) / scale) * next
    scale = next
    touched = true
    apply()
  }

  const zoomCenter = (factor) => {
    const r = div.getBoundingClientRect()
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor)
  }

  const panByPx = (dx, dy) => {
    const k = pxPerUnit()
    tx += dx / k
    ty += dy / k
    touched = true
    apply()
  }

  // ---------- fullscreen (div stays in place; a placeholder holds its layout slot) ----------
  let placeholder = null
  const enter = () => {
    if (div.classList.contains('mmd-fullscreen')) return
    placeholder = document.createElement('div')
    placeholder.style.height = `${div.offsetHeight}px`
    div.before(placeholder)
    div.classList.add('mmd-fullscreen')
    document.documentElement.style.overflow = 'hidden'
    btnFull.textContent = '✕'
    btnFull.title = 'Close fullscreen (Esc)'
    fsIndex = index
    activeFs = { div, exit, zoomCenter, reset, panByPx, step }
  }
  function exit() {
    div.classList.remove('mmd-fullscreen')
    if (placeholder) placeholder.remove()
    placeholder = null
    document.documentElement.style.overflow = ''
    btnFull.textContent = '⤢'
    btnFull.title = 'Fullscreen'
    fsIndex = null
    activeFs = null
  }
  const toggleFullscreen = () => (div.classList.contains('mmd-fullscreen') ? exit() : enter())

  // ---------- wire up buttons ----------
  onPress(btnIn, () => zoomCenter(ZOOM_STEP))
  onPress(btnOut, () => zoomCenter(1 / ZOOM_STEP))
  onPress(btnUp, () => panByPx(0, step()))
  onPress(btnDown, () => panByPx(0, -step()))
  onPress(btnLeft, () => panByPx(step(), 0))
  onPress(btnRight, () => panByPx(-step(), 0))
  onPress(btnReset, reset, false)
  onPress(btnFull, toggleFullscreen, false)

  // ---------- wheel / pinch ----------
  div.addEventListener(
    'wheel',
    (e) => {
      const inFs = div.classList.contains('mmd-fullscreen')
      if (WHEEL_NEEDS_MODIFIER && !inFs && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)))
    },
    { passive: false }
  )

  // ---------- drag to pan + two-finger pinch (pointer events: mouse, pen, touch) ----------
  const ptrs = new Map()
  let lastDist = 0
  let lastCx = 0
  let lastCy = 0
  const pinchState = () => {
    const [a, b] = [...ptrs.values()]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  div.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mmd-ctl')) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { div.setPointerCapture(e.pointerId) } catch (_) {}
    div.classList.add('mmd-dragging')
    if (ptrs.size === 2) {
      const s = pinchState()
      lastDist = s.dist
      lastCx = s.cx
      lastCy = s.cy
    }
    if (e.pointerType === 'mouse') e.preventDefault()
  })

  div.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (ptrs.size === 1) {
      panByPx(dx, dy)
    } else if (ptrs.size === 2) {
      const s = pinchState()
      if (lastDist) zoomAt(s.cx, s.cy, s.dist / lastDist)
      panByPx(s.cx - lastCx, s.cy - lastCy)
      lastDist = s.dist
      lastCx = s.cx
      lastCy = s.cy
    }
  })

  const endPointer = (e) => {
    ptrs.delete(e.pointerId)
    lastDist = 0
    if (!ptrs.size) div.classList.remove('mmd-dragging')
  }
  div.addEventListener('pointerup', endPointer)
  div.addEventListener('pointercancel', endPointer)

  div.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.mmd-ctl')) reset()
  })

  // Keep "fit" correct when the box resizes (window resize, fullscreen toggle)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (!touched) fit()
      apply()
    }).observe(div)
  }

  // ---------- initial state ----------
  if (!saved || !saved.touched) fit()
  apply()
  if (fsIndex === index) enter() // re-render while fullscreen: stay fullscreen
}

function attachMermaidZoom() {
  ensureStyles()
  bindGlobalKeys()
  const divs = document.querySelectorAll('.mermaid')

  divs.forEach((div, index) => {
    if (div.dataset.zoomReady === 'true') return
    const svg = div.querySelector('svg')
    if (!svg) {
      // Mermaid renders asynchronously: wait for the <svg> to land, then retry.
      if (pending.has(div)) return
      pending.add(div)
      const observer = new MutationObserver(() => {
        if (div.querySelector('svg')) {
          observer.disconnect()
          pending.delete(div)
          attachMermaidZoom()
        }
      })
      observer.observe(div, { childList: true, subtree: true })
      return
    }
    setup(div, svg, index)
  })

  // Fullscreen diagram no longer exists (e.g. block deleted): release the scroll lock
  if (fsIndex !== null && fsIndex >= divs.length) {
    document.documentElement.style.overflow = ''
    fsIndex = null
    activeFs = null
  }
}

export default attachMermaidZoom
