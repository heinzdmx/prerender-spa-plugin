var Hapi = require('hapi')
var Inert = require('inert')
var H2O2 = require('h2o2')
var Path = require('path')
var Phantom = require('phantomjs-prebuilt')
var ChildProcess = require('child_process')
var PortFinder = require('portfinder')
var url = require('url')

module.exports = function (staticDir, route, options, callback) {
  function serveAndPrerenderRoute () {
    PortFinder.getPort(function (error, port) {
      if (error) throw error

      var Server = new Hapi.Server({
        connections: {
          routes: {
            files: {
              relativeTo: staticDir
            }
          }
        }
      })

      Server.connection({ port: port })

      Server.register([Inert, H2O2], function (error) {
        if (error) throw error      

        Server.route({
          method: 'GET',
          path: route,
          handler: function (request, reply) {
            reply.file(
              Path.join(staticDir, 'index.html')
            )
          }
        })

        // allow the use of a local proxy table
        let proxyTable = options.proxyTable || {}

        Object.keys(proxyTable).forEach(function (proxy) {
          var proxyOptions = proxyTable[proxy]
          if (typeof proxyOptions === 'string') {
            proxyOptions = { target: proxyOptions }
          }

          var rewriteUrlRegex = null
          var rewriteUrlTo = ''

          if (proxyOptions.pathRewrite) {
            var rewriteRule = Object.keys(proxyOptions.pathRewrite)[0]
            rewriteUrlTo = proxyOptions.pathRewrite[rewriteRule]
            rewriteUrlRegex = new RegExp(rewriteRule)
          }
          var targetHost = url.parse(proxyOptions.target)

          Server.route({
            method: '*',
            path: proxy + (proxy.slice(-1) === '/' ? '' : '/') + '{path*}',
            handler: {
              proxy: {
                mapUri: function (request, callback) {
                  var requestUrl = request.url
                  requestUrl.protocol = targetHost.protocol
                  requestUrl.hostname = targetHost.hostname
                  requestUrl.port = targetHost.port
                  if (rewriteUrlRegex) {
                    requestUrl.pathname = requestUrl.pathname.replace(rewriteUrlRegex, rewriteUrlTo)
                  }

                  callback(null, requestUrl.format(), request.headers)
                },
                passThrough: true
              }
            }
          })
        })

        Server.route({
          method: 'GET',
          path: '/{param*}',
          handler: {
            directory: {
              path: '.',
              redirectToSlash: true,
              index: true
            }
          }
        })

        Server.start(function (error) {
          // If port is already bound, try again with another port
          if (error) return serveAndPrerenderRoute()

          var maxAttempts = options.maxAttempts || 5
          var attemptsSoFar = 0

          var phantomArguments = [
            Path.join(__dirname, 'phantom-page-render.js'),
            'http://localhost:' + port + route,
            JSON.stringify(options)
          ]

          if (options.phantomOptions) {
            phantomArguments.unshift(options.phantomOptions)
          }

          function capturePage () {
            attemptsSoFar += 1

            ChildProcess.execFile(
              Phantom.path,
              phantomArguments,
              {maxBuffer: 1048576},
              function (error, stdout, stderr) {
                if (error || stderr) {
                  // Retry if we haven't reached the max number of capture attempts
                  if (attemptsSoFar <= maxAttempts) {
                    return capturePage()
                  } else {
                    if (error) throw stdout
                    if (stderr) throw stderr
                  }
                }
                callback(stdout)
                Server.stop()
              }
            )
          }
          capturePage()
        })
      })
    })
  }
  serveAndPrerenderRoute()
}
