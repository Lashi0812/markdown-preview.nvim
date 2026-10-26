const fs = require('fs')
const path = require('path')
const logger = require('./lib/util/logger')('app/routes')

const routes = []

const use = function (route) {
  routes.unshift((req, res, next) => () => route(req, res, next))
}

// markdown file extensions, plus anything listed in g:mkdp_filetypes
const mdExtensions = ['.md', '.mkd', '.mdown', '.mkdn', '.mdwn']

const isMarkdownBuffer = (name, filetypes) => {
  const ext = path.extname(name).toLowerCase()
  if (mdExtensions.includes(ext)) return true
  // match by filetype name without extension, e.g. "markdown"
  const base = path.basename(name).toLowerCase()
  return (filetypes || []).some(ft => ft && (base === ft.toLowerCase() || ext === '.' + ft.toLowerCase()))
}

const hasActiveClients = (clients, bufnr) => {
  const list = clients[bufnr]
  return !!(list && list.some(c => c.connected))
}

// /page/:number
use((req, res, next) => {
  if (/\/page\/\d+/.test(req.asPath)) {
    return fs.createReadStream('./out/index.html').pipe(res)
  }
  next()
})

// /_next/path
use((req, res, next) => {
  if (/\/_next/.test(req.asPath)) {
    return fs.createReadStream(path.join('./out', req.asPath)).pipe(res)
  }
  next()
})

// /_static/markdown.css
// /_static/highlight.css
use((req, res, next) => {
  try {
    if (req.mkcss && req.asPath === '/_static/markdown.css') {
      if (fs.existsSync(req.mkcss)) {
        return fs.createReadStream(req.mkcss).pipe(res)
      }
    } else if (req.hicss && req.asPath === '/_static/highlight.css') {
      if (fs.existsSync(req.hicss)) {
        return fs.createReadStream(req.hicss).pipe(res)
      }
    }
  } catch (e) {
    logger.error('load diy css fail: ', req.asPath, req.mkcss, req.hicss)
  }
  next()
})

// /_static/path
use((req, res, next) => {
  if (/\/_static/.test(req.asPath)) {
    const fpath = path.join('./', req.asPath)
    if (fs.existsSync(fpath)) {
      return fs.createReadStream(fpath).pipe(res)
    } else {
      logger.error('No such file:', req.asPath, req.mkcss, req.hicss)
    }
  }
  next()
})

// images
use(async (req, res, next) => {
  logger.info('image route: ', req.asPath)
  const reg = /^\/_local_image_/
  if (reg.test(req.asPath) && req.asPath !== '') {
    const plugin = req.plugin
    const buffers = await plugin.nvim.buffers
    const buffer = buffers.find(b => b.id === Number(req.bufnr))
    if (buffer) {
      let fileDir = ''
      if (req.custImgPath !== '' ){
        fileDir = req.custImgPath
      } else {
        fileDir = await plugin.nvim.call('expand', `#${req.bufnr}:p:h`)
      }

      logger.info('fileDir', fileDir)

      const  mingw_home=process.env.MINGW_HOME;
      if (mingw_home){
        if(! fileDir.includes(':')){
          // fileDir is unix-like:      /Z/x/y/...., 'Z' means Z:
          // the win-like fileDir should be: Z:\x\y...
          const cygpath = 'cygpath.exe'
          const cmd=cygpath+' -w'+' -a '+fileDir ;
          logger.info('cmd',cmd)
       
          const { execSync } = require('node:child_process');
          const result = execSync(cmd);
          fileDir=result.toString('utf8').replace('\n','');

          logger.info('New fileDir',fileDir);
        }  
      }

      const decodedPath = decodeURIComponent(decodeURIComponent(req.asPath.replace(reg, ''))).replace(/\\ /g, ' ')
      let imgPath
      if (decodedPath[0] !== '/' && decodedPath[0] !== '\\') {
        // relative reference: try the buffer dir first, then walk up ancestor
        // directories (notes often reference a shared assets folder above)
        imgPath = path.join(fileDir, decodedPath)
        if (!fs.existsSync(imgPath)) {
          let tmpDirPath = fileDir
          while (tmpDirPath !== '/' && tmpDirPath !== '\\') {
            tmpDirPath = path.normalize(path.join(tmpDirPath, '..'))
            const tmpImgPath = path.join(tmpDirPath, decodedPath)
            if (fs.existsSync(tmpImgPath)) {
              imgPath = tmpImgPath
              break
            }
          }
        }
      } else {
        imgPath = decodedPath
        if (!fs.existsSync(imgPath)) {
          // absolute reference not found: try it relative to buffer dir ancestors
          const relPath = decodedPath.replace(/^[/\\\\]+/, '')
          let tmpDirPath = fileDir
          while (tmpDirPath !== '/' && tmpDirPath !== '\\') {
            tmpDirPath = path.normalize(path.join(tmpDirPath, '..'))
            const tmpImgPath = path.join(tmpDirPath, relPath)
            if (fs.existsSync(tmpImgPath)) {
              imgPath = tmpImgPath
              break
            }
          }
        }
      }
      logger.info('imgPath', imgPath);
      
      if (fs.existsSync(imgPath) && !fs.statSync(imgPath).isDirectory()) {
        const ext = path.extname(imgPath).toLowerCase()
        const mime = {
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
          '.ico': 'image/x-icon',
          '.avif': 'image/avif',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.ogg': 'audio/ogg',
          '.oga': 'audio/ogg',
          '.m4a': 'audio/mp4',
          '.flac': 'audio/flac',
          '.aac': 'audio/aac',
          '.opus': 'audio/opus',
          '.wma': 'audio/x-ms-wma',
          '.weba': 'audio/webm',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mkv': 'video/x-matroska',
          '.mov': 'video/quicktime',
          '.ogv': 'video/ogg',
          '.avi': 'video/x-msvideo'
        }[ext]
        if (mime) {
          res.setHeader('content-type', mime)
        }
        return fs.createReadStream(imgPath).pipe(res)
      }
      logger.error('image not exists: ', imgPath)
    }
  }
  next()
})

// never let browsers cache the dynamic zk/preview responses (stale 302s)
const noCache = (res) => {
  res.setHeader('cache-control', 'no-store, max-age=0')
  res.setHeader('pragma', 'no-cache')
}

// /api/buffers — same set as snacks picker "buffers" (space fb):
// listed + loaded buffers, nofile excluded; current buffer included on top
use(async (req, res, next) => {
  if (req.asPath === '/api/buffers') {
    noCache(res)
    try {
      const infos = await req.plugin.nvim.call('getbufinfo', [{ buflisted: 1, bufloaded: 1 }])
      const currentBuf = await req.plugin.nvim.buffer
      const list = []
      for (const info of infos) {
        const name = info.name
        if (!name) continue
        // mirror snacks: skip scratch/nofile buffers
        let buftype = ''
        try { buftype = await req.plugin.nvim.call('getbufvar', [info.bufnr, '&buftype']) } catch (e) {}
        if (buftype === 'nofile') continue
        list.push({
          id: info.bufnr,
          name: path.basename(name),
          path: name,
          visible: Array.isArray(info.windows) && info.windows.length > 0,
          previewing: hasActiveClients(req.clients, info.bufnr),
          current: info.bufnr === currentBuf.id,
          modified: !!info.changed
        })
      }
      // current buffer first, then visible/previewed ones, then by bufnr
      list.sort((a, b) => ((b.current - a.current) || ((b.visible + b.previewing) - (a.visible + a.previewing))) || (a.id - b.id))
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(list))
    } catch (e) {
      logger.error('list buffers fail: ', e)
      res.statusCode = 500
      return res.end(JSON.stringify({ error: String(e) }))
    }
  }
  next()
})

// / — index page listing markdown + active buffers
use((req, res, next) => {
  if (req.asPath === '/' || req.asPath === '/index.html') {
    const fpath = path.join(__dirname, 'index-page.html')
    if (fs.existsSync(fpath)) {
      return fs.createReadStream(fpath).pipe(res)
    }
  }
  next()
})

// ---------------------------------------------------------------------------
// zk wiki-links: resolve [[target]] links to live preview pages
// ---------------------------------------------------------------------------

// notebook root cache (per nvim session; recomputed when empty or stale)
let zkRootCache = ''

const getZkRoot = async (plugin, bufferName) => {
  if (zkRootCache && fs.existsSync(path.join(zkRootCache, '.zk'))) return zkRootCache
  zkRootCache = ''
  // prefer the notebook root of the current buffer via zk-nvim's helper
  try {
    const root = await plugin.nvim.call('zk#util#notebook_root', [bufferName || ''])
    if (root && fs.existsSync(path.join(root, '.zk'))) {
      zkRootCache = root
      return root
    }
  } catch (e) {
    // zk-nvim not loaded; fall through to manual walk
  }
  // fallback: walk up from the buffer path looking for .zk/
  let dir = bufferName ? path.dirname(bufferName) : ''
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.zk'))) {
      zkRootCache = dir
      return dir
    }
    dir = path.dirname(dir)
  }
  return ''
}

// bounded basename search under the notebook's note dirs (cached)
const zkNameCache = {} // basename -> abs path | null

const findNoteByBasename = async (root, target) => {
  const base = path.basename(target).toLowerCase()
  if (base in zkNameCache) return zkNameCache[base]
  const dirs = ['notes', 'resources', 'mocs', 'questions']
  let found = null
  for (const d of dirs) {
    const dirPath = path.join(root, d)
    if (!fs.existsSync(dirPath)) continue
    // recursive scan with entry cap; descend into ALL subdirs first,
    // then match .md files by basename (dir names don't end in .md, so
    // the directory check must come before the extension filter)
    const stack = [dirPath]
    let scanned = 0
    while (stack.length && scanned < 20000) {
      const cur = stack.pop()
      let entries
      try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch (e) { continue }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          stack.push(path.join(cur, ent.name))
          continue
        }
        scanned++
        const n = ent.name.toLowerCase()
        if (n.endsWith('.md') && (n === base + '.md' || n === base)) {
          found = path.join(cur, ent.name)
          break
        }
      }
      if (found) break
    }
    if (found) break
  }
  zkNameCache[base] = found
  return found
}

// find an already-open buffer for an absolute path via one getbufinfo() call
const findOpenBufnr = async (nvim, abs) => {
  try {
    const infos = await nvim.call('getbufinfo', [{ buflisted: 1, bufloaded: 1 }])
    for (const info of infos) {
      if (info.name && path.resolve(info.name) === path.resolve(abs)) return info.bufnr
    }
  } catch (e) {}
  return -1
}

// /api/zk/resolve?target=<wiki-link target> — 302 to the note's preview
use(async (req, res, next) => {
  if (req.asPath === '/api/zk/resolve') {
    const query = (req.url.split('?')[1] || '')
    const params = new URLSearchParams(query)
    const target = params.get('target') || ''
    noCache(res)
    if (!target) {
      res.statusCode = 400
      return res.end('missing target')
    }
    try {
      const bufferName = await req.plugin.nvim.call('expand', ['%:p'])
      const root = await getZkRoot(req.plugin, bufferName)
      if (!root) {
        res.statusCode = 302
        return res.end()
      }
      // candidate 1: direct path under root (handles "recall/foo" style)
      const direct = path.join(root, target + '.md')
      let abs = ''
      if (fs.existsSync(direct)) {
        abs = direct
      } else {
        // candidate 2: basename search across note dirs
        abs = await findNoteByBasename(root, target) || ''
      }
      if (!abs) {
        res.statusCode = 302
        res.setHeader('location', '/zk/dead?target=' + encodeURIComponent(target))
        return res.end()
      }
      // already open? jump straight to its preview page (single getbufinfo call)
      const bufnr = await findOpenBufnr(req.plugin.nvim, abs)
      if (bufnr !== -1) {
        res.statusCode = 302
        res.setHeader('location', '/page/' + bufnr)
      } else {
        res.statusCode = 302
        res.setHeader('location', '/zk/open?path=' + encodeURIComponent(abs))
      }
      return res.end()
    } catch (e) {
      logger.error('zk resolve fail: ', e)
      res.statusCode = 500
      return res.end(JSON.stringify({ error: String(e) }))
    }
  }
  next()
})

// /zk/open?path=<abs> — open the note in nvim, then redirect to its preview
use(async (req, res, next) => {
  if (req.asPath === '/zk/open') {
    const query = (req.url.split('?')[1] || '')
    const params = new URLSearchParams(query)
    const abs = params.get('path') || ''
    noCache(res)
    if (!abs || !fs.existsSync(abs)) {
      res.statusCode = 302
      res.setHeader('location', '/zk/dead?target=' + encodeURIComponent(path.basename(abs)))
      return res.end()
    }
    try {
      // idempotent: if it became open in the meantime, skip opening entirely
      let bufnr = await findOpenBufnr(req.plugin.nvim, abs)
      if (bufnr === -1) {
        // Open WITHOUT firing BufRead autocmds: bufadd() returns the bufnr
        // directly and loads nothing, so no plugin/LSP code runs between
        // the open and our redirect.
        const newBuf = await req.plugin.nvim.call('bufadd', [abs])
        if (newBuf && typeof newBuf.id !== 'undefined') {
          bufnr = newBuf.id
        } else if (typeof newBuf === 'number' && newBuf > 0) {
          bufnr = newBuf
        } else {
          // resolve by path as a fallback
          const infos = await req.plugin.nvim.call('getbufinfo', [{ buflisted: 1 }])
          const hit = infos.find(i => i.name && path.resolve(i.name) === path.resolve(abs))
          bufnr = hit ? hit.bufnr : -1
        }
        if (bufnr !== -1) {
          // load the content without autocmds
          try { await req.plugin.nvim.call('bufload', [bufnr]) } catch (e) {}
        }
      }
      if (bufnr === -1) {
        res.statusCode = 302
        res.setHeader('location', '/zk/dead?target=' + encodeURIComponent(path.basename(abs)))
        return res.end()
      }
      res.statusCode = 302
      res.setHeader('location', '/page/' + bufnr)
      return res.end()
    } catch (e) {
      logger.error('zk open fail: ', e)
      res.statusCode = 500
      return res.end(JSON.stringify({ error: String(e) }))
    }
  }
  next()
})

// /zk/dead?target=<t> — note not found page
use((req, res, next) => {
  if (req.asPath === '/zk/dead') {
    const query = (req.url.split('?')[1] || '')
    const params = new URLSearchParams(query)
    const target = params.get('target') || ''
    noCache(res)
    res.setHeader('content-type', 'text/html')
    return res.end(
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>note not found</title>' +
      '<style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;color:#4c4f69;background:#eff1f5}' +
      'code{background:#fff;padding:.2rem .5rem;border-radius:4px}</style></head><body>' +
      '<h1>Note not found</h1>' +
      '<p>No note matches <code>' + target.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</code>.</p>' +
      '<p><a href="/">Back to buffer list</a></p></body></html>'
    )
  }
  next()
})

// 404
use((req, res) => {
  res.statusCode = 404
  return fs.createReadStream(path.join('./out', '404.html')).pipe(res)
})

module.exports = function (req, res, next) {
  return routes.reduce((next, route) => route(req, res, next), next)()
}
