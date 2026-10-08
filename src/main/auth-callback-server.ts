import { createServer, type Server } from 'node:http'

export type AuthCallbackListener = {
  redirectUri: string
  waitForCallback: (timeoutMs: number) => Promise<string>
  close: () => Promise<void>
}

const successPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Everlook is signing in</title>
</head>
<body>
  <p>You can close this tab. Everlook is finishing sign-in.</p>
</body>
</html>`

function requestUrl(requestUrl: string | undefined, origin: string): URL | null {
  try {
    return new URL(requestUrl ?? '/', origin)
  } catch {
    return null
  }
}

export function startAuthCallbackServer(): Promise<AuthCallbackListener> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer()

    const fail = (error: Error): void => {
      server.close()
      reject(error)
    }

    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('The loopback authorization server bound an unexpected address.'))
        return
      }

      const origin = `http://127.0.0.1:${address.port}`
      const redirectUri = `${origin}/callback`
      let resolveFirst: ((callback: string) => void) | null = null
      const firstCallback = new Promise<string>((resolveCallback) => {
        resolveFirst = resolveCallback
      })

      server.on('request', (request, response) => {
        const url = requestUrl(request.url, origin)
        if (url === null || url.pathname !== '/callback' || (request.method !== 'GET' && request.method !== 'HEAD')) {
          response.writeHead(404)
          response.end()
          return
        }

        const callback = `${redirectUri}${url.search}`
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        response.end(request.method === 'HEAD' ? undefined : successPage)

        if (resolveFirst !== null) {
          const settle = resolveFirst
          resolveFirst = null
          settle(callback)
        }
      })

      resolve({
        redirectUri,
        waitForCallback: (timeoutMs) =>
          new Promise((resolveCallback, rejectCallback) => {
            const timer = setTimeout(() => {
              rejectCallback(new Error('Timed out waiting for the browser to finish signing in.'))
            }, timeoutMs)
            void firstCallback.then(
              (callback) => {
                clearTimeout(timer)
                resolveCallback(callback)
              },
              (error: unknown) => {
                clearTimeout(timer)
                rejectCallback(error)
              }
            )
          }),
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) rejectClose(error)
              else resolveClose()
            })
          })
      })
    })
  })
}
