/*
 * GitHub-style pan/zoom for mermaid diagrams.
 *
 * Mermaid flowcharts with long labels render as one very wide, short SVG
 * (e.g. 3194x243 viewBox). Fitting it to the page width makes it tiny,
 * and forcing a readable height makes it scroll in both directions.
 * Instead of scrolling, let the user pan/zoom like GitHub does:
 *   - mouse wheel / trackpad pinch over a diagram zooms (centered on cursor)
 *   - drag with the mouse to pan
 *   - double-click resets
 * Zoom is applied as an SVG transform on a <g> wrapper so the layout
 * box stays put and sync-scroll anchors keep working.
 */

const MIN_SCALE = 0.3
const MAX_SCALE = 4
const ZOOM_STEP = 1.15

function attachMermaidZoom() {
  document.querySelectorAll('.mermaid').forEach((div) => {
    if (div.dataset.zoomReady === 'true') return
    const svg = div.querySelector('svg')
    if (!svg) return
    div.dataset.zoomReady = 'true'

    let scale = 1
    let tx = 0
    let ty = 0
    let g = null

    const apply = () => {
      if (!g) return
      g.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`)
    }

    const reset = () => {
      scale = 1
      tx = 0
      ty = 0
      apply()
    }

    // Convert a client-space point to the SVG's local (viewBox) space,
    // accounting for the current pan/zoom.
    const toLocal = (clientX, clientY) => {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return { x: 0, y: 0 }
      const p = pt.matrixTransform(ctm.inverse())
      return { x: p.x, y: p.y }
    }

    // Wrap existing children in a <g> so we can transform without
    // touching mermaid's own SVG attributes.
    if (!div.__zoomG) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      while (svg.firstChild) g.appendChild(svg.firstChild)
      svg.appendChild(g)
      div.__zoomG = g
    }

    // --- wheel: zoom around cursor position ---
    div.addEventListener('wheel', (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
      if (newScale === scale) return
      const local = toLocal(e.clientX, e.clientY)
      // Keep the point under the cursor fixed while scaling.
      tx = local.x - ((local.x - tx) / scale) * newScale
      ty = local.y - ((local.y - ty) / scale) * newScale
      scale = newScale
      apply()
    }, { passive: false })

    // --- drag to pan ---
    let dragging = false
    let lastX = 0
    let lastY = 0
    div.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
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

    // --- double-click resets ---
    div.addEventListener('dblclick', reset)

    div.style.cursor = 'grab'
  })
}

export default attachMermaidZoom
