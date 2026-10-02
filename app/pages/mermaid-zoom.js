/*
 * GitHub-style pan/zoom for mermaid diagrams.
 *
 * Mermaid flowcharts with long labels render as one very wide, short SVG
 * (e.g. 3194x243 viewBox). Fitting it to the page width makes it tiny,
 * and forcing a readable height makes it scroll in both directions.
 * Instead of scrolling, let the user pan/zoom like GitHub does:
 *   - hover reveals a control bar: [ + ] [ % ] [ − ] [ ⤢ fullscreen ]
 *   - mouse wheel / trackpad pinch zooms (centered on cursor)
 *   - drag with the mouse to pan
 *   - double-click resets; Esc closes fullscreen
 * Zoom is applied as an SVG transform on a <g> wrapper so the layout
 * box stays put and sync-scroll anchors keep working. Fullscreen opens
 * a fixed overlay that reuses the same zoom/pan state.
 */

const MIN_SCALE = 0.3
const MAX_SCALE = 4
const ZOOM_STEP = 1.25

const BTN_STYLES = `
.mmd-zoom-ctl {
	position: absolute;
	top: 6px;
	right: 6px;
	display: none;
	gap: 4px;
	z-index: 10;
}
.mermaid:hover > .mmd-zoom-ctl,
.mmd-fullscreen > .mmd-zoom-ctl {
	display: flex;
}
.mmd-zoom-btn {
	min-width: 26px;
	height: 26px;
	padding: 0 6px;
	border: 1px solid rgba(128, 128, 128, 0.5);
	border-radius: 4px;
	background: rgba(30, 30, 30, 0.85);
	color: #e6edf3;
	font: 13px/1 "JetBrains Mono", monospace;
	cursor: pointer;
	user-select: none;
}
.mmd-zoom-btn:hover {
	background: rgba(88, 166, 255, 0.3);
	border-color: #58a6ff;
}
.mmd-fullscreen {
	position: fixed !important;
	inset: 0 !important;
	width: 100vw !important;
	height: 100vh !important;
	background: #1e1e1e;
	z-index: 99998;
	cursor: grab;
}
.mmd-fullscreen .mmd-zoom-ctl {
	display: flex;
}
`

function ensureStyles() {
  if (document.getElementById('mmd-zoom-styles')) return
  const style = document.createElement('style')
  style.id = 'mmd-zoom-styles'
  style.textContent = BTN_STYLES
  document.head.appendChild(style)
}

function attachMermaidZoom() {
  ensureStyles()
  document.querySelectorAll('.mermaid').forEach((div) => {
    if (div.dataset.zoomReady === 'true') return
    const svg = div.querySelector('svg')
    if (!svg) {
      // Mermaid renders asynchronously — the .mermaid div exists but its
      // <svg> child isn't in the DOM yet. Watch for it and attach once it
      // lands, instead of skipping this diagram forever.
      const observer = new MutationObserver(() => {
        if (div.querySelector('svg')) {
          observer.disconnect()
          attachMermaidZoom()
        }
      })
      observer.observe(div, { childList: true, subtree: true })
      return
    }
    div.dataset.zoomReady = 'true'
    div.style.position = 'relative'

    let scale = 1
    let tx = 0
    let ty = 0
    let g = null

    // --- control bar: + / % / − / fullscreen ---
    const ctl = document.createElement('div')
    ctl.className = 'mmd-zoom-ctl'
    const btnIn = document.createElement('button')
    btnIn.className = 'mmd-zoom-btn'
    btnIn.type = 'button'
    btnIn.textContent = '+'
    const btnPct = document.createElement('button')
    btnPct.className = 'mmd-zoom-btn'
    btnPct.type = 'button'
    btnPct.textContent = '100%'
    const btnOut = document.createElement('button')
    btnOut.className = 'mmd-zoom-btn'
    btnOut.type = 'button'
    btnOut.textContent = '−'
    const btnFull = document.createElement('button')
    btnFull.className = 'mmd-zoom-btn'
    btnFull.type = 'button'
    btnFull.textContent = '⤢'
    ctl.appendChild(btnIn)
    ctl.appendChild(btnPct)
    ctl.appendChild(btnOut)
    ctl.appendChild(btnFull)
    div.appendChild(ctl)

    // Wrap existing SVG children in a <g> so we can transform without
    // touching mermaid's own SVG attributes.
    if (!div.__zoomG) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      while (svg.firstChild) g.appendChild(svg.firstChild)
      svg.appendChild(g)
      div.__zoomG = g
    }

    const apply = () => {
      if (g) g.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`)
      btnPct.textContent = `${Math.round(scale * 100)}%`
    }

    const reset = () => {
      scale = 1
      tx = 0
      ty = 0
      apply()
    }

    // Convert a client-space point to the SVG's local (viewBox) space.
    const toLocal = (clientX, clientY) => {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return { x: 0, y: 0 }
      const p = pt.matrixTransform(ctm.inverse())
      return { x: p.x, y: p.y }
    }

    // Zoom centered on a client-space point.
    const zoomAt = (clientX, clientY, factor) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
      if (newScale === scale) return
      const local = toLocal(clientX, clientY)
      tx = local.x - ((local.x - tx) / scale) * newScale
      ty = local.y - ((local.y - ty) / scale) * newScale
      scale = newScale
      apply()
    }

    // Zoom centered on the diagram's visible center (for buttons).
    const zoomCenter = (factor) => {
      const rect = div.getBoundingClientRect()
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
    }

    // --- fullscreen overlay ---
    let fsHost = null
    const toggleFullscreen = () => {
      if (fsHost) {
        // close: move the diagram back to its original spot in the doc
        div.parentElement.appendChild(div)
        fsHost.remove()
        fsHost = null
        return
      }
      fsHost = document.createElement('div')
      fsHost.className = 'mmd-fullscreen'
      document.body.appendChild(fsHost)
      // move the whole diagram (svg + controls) into the overlay;
      // the zoom state lives on the <g> so it carries over
      fsHost.appendChild(div)
    }

    btnIn.addEventListener('click', () => zoomCenter(ZOOM_STEP))
    btnOut.addEventListener('click', () => zoomCenter(1 / ZOOM_STEP))
    btnPct.addEventListener('click', reset)
    btnFull.addEventListener('click', toggleFullscreen)

    // --- wheel: zoom around cursor position ---
    div.addEventListener('wheel', (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      zoomAt(e.clientX, e.clientY, factor)
    }, { passive: false })

    // --- drag to pan ---
    let dragging = false
    let lastX = 0
    let lastY = 0
    div.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.mmd-zoom-ctl')) return
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      div.style.cursor = 'grabbing'
      e.preventDefault()
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const localNow = toLocal(e.clientX, e.clientY)
      const localLast = toLocal(lastX, lastY)
      tx += localNow.x - localLast.x
      ty += localNow.y - localLast.y
      lastX = e.clientX
      lastY = e.clientY
      apply()
    })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      div.style.cursor = 'grab'
    })

    // --- double-click resets; Esc closes fullscreen ---
    div.addEventListener('dblclick', reset)
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fsHost) toggleFullscreen()
    })

    div.style.cursor = 'grab'
  })
}

export default attachMermaidZoom
