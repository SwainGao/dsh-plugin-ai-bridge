import { createServer } from 'node:http'

/** Start a mock HTTP server on an ephemeral port. */
export function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          server.closeAllConnections?.()
          server.close(r)
        }),
      })
    })
  })
}

/** Read a request body to a string. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Send a JSON response. */
export function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** Send an SSE (text/event-stream) response with the given `data:` payloads. */
export function sse(res, payloads) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}
