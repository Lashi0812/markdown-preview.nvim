/*
 * Upgrades every <audio> element rendered by markdown (see image.js) into a
 * modern, compact player with: play/pause, seek bar with progress fill,
 * current/total time, playback-speed cycling and mute.
 *
 * The native <audio> element is kept (hidden) as the source of truth, so
 * markup produced by the renderer stays simple and degrades gracefully
 * (plain <audio controls> if JS fails).
 */

const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z"/></svg>'
const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h3v12H4zM9 2h3v12H9z"/></svg>'
const ICON_VOLUME = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6v4h3l4 3V3L5 6H2zm9.5 2a2.5 2.5 0 0 0-1.5-2.3v4.6a2.5 2.5 0 0 0 1.5-2.3z"/></svg>'
const ICON_MUTED = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6v4h3l4 3V3L5 6H2zm11.3-.3l-1.4-1.4-1.4 1.4L9 4.3 10.4 3 9 1.6l1.4-1.4 1.4 1.4 1.4-1.4L14.6 1.6 13.2 3l1.4 1.4-1.3 1.3z"/></svg>'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function formatTime (s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}

const STYLE_ID = 'mkdp-audio-style'

const CSS = `
.mkdp-audio{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 10px;margin:10px 0;max-width:480px;border:1px solid rgba(127,127,127,.28);border-radius:9px;background:rgba(127,127,127,.07);color:inherit;font-size:12px;line-height:1;box-sizing:border-box}
.mkdp-audio audio{display:none}
.mkdp-audio-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:7px;background:transparent;color:inherit;cursor:pointer;flex:none;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.mkdp-audio-btn:hover{background:rgba(127,127,127,.16)}
.mkdp-audio-btn:active{background:rgba(127,127,127,.24)}
.mkdp-audio-btn svg{width:14px;height:14px;fill:currentColor;display:block}
.mkdp-audio-play{width:30px;height:30px;border-radius:50%;background:rgba(127,127,127,.14)}
.mkdp-audio-play:hover{background:rgba(127,127,127,.24)}
.mkdp-audio-speed{width:auto;min-width:38px;padding:0 7px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;margin-left:auto}
.mkdp-audio-jump{width:auto;min-width:32px;padding:0 5px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.mkdp-audio-bar{order:10;flex:1 1 100%;display:flex;align-items:center;gap:8px;min-width:0}
.mkdp-audio-seek{flex:1 1 auto;min-width:0;height:5px;margin:0;padding:0;-webkit-appearance:none;appearance:none;border:none;border-radius:3px;background:rgba(127,127,127,.3);cursor:pointer;outline-offset:4px}
.mkdp-audio-seek::-webkit-slider-runnable-track{background:transparent;height:5px;border-radius:3px}
.mkdp-audio-seek::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;margin-top:-4px;border:none;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px rgba(0,0,0,.12)}
.mkdp-audio-seek::-moz-range-track{background:transparent;height:5px;border-radius:3px}
.mkdp-audio-seek::-moz-range-thumb{width:13px;height:13px;border:none;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px rgba(0,0,0,.12)}
.mkdp-audio-time{flex:none;min-width:88px;text-align:center;font-variant-numeric:tabular-nums;opacity:.85;user-select:none}
@media (max-width:480px){
.mkdp-audio{width:100%;max-width:100%;padding:8px 10px;gap:8px}
.mkdp-audio-btn{width:30px;height:30px}
.mkdp-audio-play{width:36px;height:36px}
.mkdp-audio-speed{min-width:42px;padding:0 8px;font-size:12px}
.mkdp-audio-jump{min-width:36px;font-size:12px}
.mkdp-audio-bar{gap:6px}
.mkdp-audio-seek{height:6px}
.mkdp-audio-time{font-size:11px;min-width:80px}
.mkdp-audio-seek::-webkit-slider-runnable-track{height:6px}
.mkdp-audio-seek::-webkit-slider-thumb{width:16px;height:16px;margin-top:-5px}
.mkdp-audio-seek::-moz-range-track{height:6px}
.mkdp-audio-seek::-moz-range-thumb{width:16px;height:16px}
}
@media (max-width:360px){
.mkdp-audio{gap:6px;padding:7px 8px}
.mkdp-audio-time{min-width:72px;font-size:10px}
.mkdp-audio-speed{min-width:36px}
}
@media (prefers-color-scheme: dark){.mkdp-audio{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.18)}}
`

function ensureStyles () {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

function upgrade (audioEl) {
  if (audioEl.parentElement && audioEl.parentElement.classList.contains('mkdp-audio')) return

  const wrap = document.createElement('div')
  wrap.className = 'mkdp-audio'
  wrap.innerHTML = `
    <button type="button" class="mkdp-audio-btn mkdp-audio-jump mkdp-audio-back10" title="Back 10 seconds" aria-label="Back 10 seconds">-10</button>
    <button type="button" class="mkdp-audio-btn mkdp-audio-play" aria-label="Play">${ICON_PLAY}</button>
    <button type="button" class="mkdp-audio-btn mkdp-audio-jump mkdp-audio-fwd10" title="Forward 10 seconds" aria-label="Forward 10 seconds">+10</button>
    <span class="mkdp-audio-time">0:00 / 0:00</span>
    <button type="button" class="mkdp-audio-btn mkdp-audio-speed" title="Playback speed" aria-label="Playback speed">1×</button>
    <button type="button" class="mkdp-audio-btn mkdp-audio-mute" aria-label="Mute">${ICON_VOLUME}</button>
    <div class="mkdp-audio-bar">
      <input type="range" class="mkdp-audio-seek" min="0" max="0" step="0.1" value="0" aria-label="Seek">
    </div>
  `

  audioEl.parentNode.insertBefore(wrap, audioEl)
  wrap.appendChild(audioEl)
  audioEl.removeAttribute('controls')
  audioEl.preload = 'metadata'

  const playBtn = wrap.querySelector('.mkdp-audio-play')
  const backBtn = wrap.querySelector('.mkdp-audio-back10')
  const fwdBtn = wrap.querySelector('.mkdp-audio-fwd10')
  const seek = wrap.querySelector('.mkdp-audio-seek')
  const timeEl = wrap.querySelector('.mkdp-audio-time')
  const speedBtn = wrap.querySelector('.mkdp-audio-speed')
  const muteBtn = wrap.querySelector('.mkdp-audio-mute')

  let speedIdx = SPEEDS.indexOf(1)
  let seeking = false

  function setProgress () {
    const d = audioEl.duration || 0
    const t = audioEl.currentTime || 0
    const pct = d > 0 ? (t / d) * 100 : 0
    seek.style.background = `linear-gradient(to right, currentColor ${pct}%, rgba(127,127,127,.3) ${pct}%)`
  }

  function syncPlay () {
    const playing = !audioEl.paused
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play')
  }

  function syncTime () {
    const d = audioEl.duration || 0
    if (Number(seek.max) !== d && isFinite(d)) {
      seek.max = String(d)
    }
    if (!seeking) {
      seek.value = String(audioEl.currentTime || 0)
    }
    timeEl.textContent = `${formatTime(audioEl.currentTime)} / ${formatTime(d)}`
    setProgress()
  }

  playBtn.addEventListener('click', () => {
    if (audioEl.paused) {
      audioEl.play().catch(() => {})
    } else {
      audioEl.pause()
    }
  })

  backBtn.addEventListener('click', () => {
    audioEl.currentTime = Math.max(0, (audioEl.currentTime || 0) - 10)
    syncTime()
  })

  fwdBtn.addEventListener('click', () => {
    const d = audioEl.duration
    const target = (audioEl.currentTime || 0) + 10
    audioEl.currentTime = isFinite(d) && target > d ? d : target
    syncTime()
  })

  audioEl.addEventListener('play', syncPlay)
  audioEl.addEventListener('pause', syncPlay)
  audioEl.addEventListener('ended', syncPlay)
  audioEl.addEventListener('loadedmetadata', syncTime)
  audioEl.addEventListener('durationchange', syncTime)
  audioEl.addEventListener('timeupdate', syncTime)

  seek.addEventListener('input', () => {
    seeking = true
    const t = Number(seek.value)
    timeEl.textContent = `${formatTime(t)} / ${formatTime(audioEl.duration || 0)}`
    const pct = audioEl.duration > 0 ? (t / audioEl.duration) * 100 : 0
    seek.style.background = `linear-gradient(to right, currentColor ${pct}%, rgba(127,127,127,.3) ${pct}%)`
  })

  seek.addEventListener('change', () => {
    audioEl.currentTime = Number(seek.value)
    seeking = false
    syncTime()
  })

  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length
    audioEl.playbackRate = SPEEDS[speedIdx]
    speedBtn.textContent = `${SPEEDS[speedIdx]}×`
  })

  muteBtn.addEventListener('click', () => {
    audioEl.muted = !audioEl.muted
    muteBtn.innerHTML = audioEl.muted ? ICON_MUTED : ICON_VOLUME
    muteBtn.setAttribute('aria-label', audioEl.muted ? 'Unmute' : 'Mute')
  })

  syncPlay()
  syncTime()
}

export default function renderAudioPlayers () {
  ensureStyles()
  document.querySelectorAll('audio').forEach(upgrade)
}
