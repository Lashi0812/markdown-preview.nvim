const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma|weba)$/i
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|ogv|avi)$/i

function localizeSrc (src) {
  if (/^(http|\/\/|data:)/.test(src)) {
    return src
  }
  return `/_local_image_${encodeURIComponent(src)}`
}

function resolveHtmlImage (tokens, idx) {
  let content = tokens[idx].content || ''

  // rewrite local src for <img>/<audio>/<video>/<source> tags,
  // and turn <img> pointing to an audio/video file into a player
  content = content.replace(/<(img|audio|video|source)\s+([^>]*?)src\s*=\s*(["'])([^\3>]+?)\3([^>]*)>/gm, (m, tag, g1, g2, g3, g4) => {
    if (/^(http|\/\/|data:)/.test(g3)) {
      return m
    }
    const local = `/_local_image_${encodeURIComponent(g3)}`
    if (tag === 'img') {
      if (AUDIO_EXT.test(g3)) {
        return `<audio controls src="${local}"></audio>`
      }
      if (VIDEO_EXT.test(g3)) {
        return `<video controls src="${local}"></video>`
      }
      return `<img ${g1}src="${local}"${g4}>`
    }
    return `<${tag} ${g1}src="${local}"${g4}>`
  })

  return content
}

function resolveImage (tokens, idx) {
  const src = tokens[idx].attrs[0][1]
  const alt = tokens[idx].content
  const resAttrs = tokens[idx].attrs.slice(2).reduce((pre, cur) => `${pre} ${cur[0]}=${cur[1]}`, '')
  if (AUDIO_EXT.test(src) || VIDEO_EXT.test(src)) {
    const tag = AUDIO_EXT.test(src) ? 'audio' : 'video'
    return `<${tag} controls src="${localizeSrc(src)}">${alt}</${tag}>`
  }
  return `<img src="${localizeSrc(src)}" alt="${alt}" ${resAttrs} />`
}

export default function localImage (md) {
  md.renderer.rules.image = resolveImage
  md.renderer.rules.html_block = resolveHtmlImage
  md.renderer.rules.html_inline = resolveHtmlImage
}
