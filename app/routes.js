const fs = require('fs')
const path = require('path')
const logger = require('./lib/util/logger')('app/routes')

const routes = []

const use = function (route) {
  routes.unshift((req, res, next) => () => route(req, res, next))
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

// 404
use((req, res) => {
  res.statusCode = 404
  return fs.createReadStream(path.join('./out', '404.html')).pipe(res)
})

module.exports = function (req, res, next) {
  return routes.reduce((next, route) => route(req, res, next), next)()
}
