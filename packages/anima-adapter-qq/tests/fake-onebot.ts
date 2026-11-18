/**
 * A fake OneBot v11 forward-WebSocket server for tests: `node:http` with a
 * hand-written upgrade handshake and frame codec (text, close, ping), so no
 * real account and no dependency are needed.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One API call the server received. */
export interface ReceivedCall {
  readonly action: string
  readonly params: Record<string, unknown>
  readonly echo: string
}

/** Answer for an action: the `data`, or a failure. */
export type Responder = (call: ReceivedCall) => unknown

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** A fake OneBot runtime. */
export class FakeOneBot {
  readonly calls: ReceivedCall[] = []
  /** Query strings of accepted connections. */
  readonly connections: string[] = []
  /** `Authorization` headers of accepted connections. */
  readonly authorizations: (string | undefined)[] = []
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly responders = new Map<string, Responder>()
  /** When false, upgrades are refused (runtime down). */
  accepting = true
  port = 0

  constructor(readonly selfId = '10001') {
    this.server = createServer((_req, res) => { res.writeHead(426); res.end() })
    this.server.on('upgrade', (req, socket: Socket) => {
      if (!this.accepting) return socket.destroy()
      const key = req.headers['sec-websocket-key']
      const accept = createHash('sha1').update(`${String(key)}${GUID}`).digest('base64')
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
      this.connections.push(new URL(req.url ?? '/', 'http://x').search)
      this.authorizations.push(req.headers.authorization)
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => this.sockets.delete(socket))
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (buffer.length < 2) return
          const opcode = buffer[0]! & 0x0f
          let length = buffer[1]! & 0x7f
          let offset = 2
          if (length === 126) { length = buffer.readUInt16BE(2); offset = 4 } else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
          const masked = (buffer[1]! & 0x80) !== 0
          const total = offset + (masked ? 4 : 0) + length
          if (buffer.length < total) return
          const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
          const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total))
          if (mask !== undefined) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
          buffer = buffer.subarray(total)
          if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return }
          if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue }
          if (opcode === 0x1) this.onText(socket, payload.toString('utf8'))
        }
      })
    })
    this.respond('get_login_info', () => ({ user_id: Number(this.selfId), nickname: 'Anima' }))
    let seq = 9000
    this.respond('send_private_msg', () => ({ message_id: ++seq }))
    this.respond('send_group_msg', () => ({ message_id: ++seq }))
  }

  /** Start listening on a free local port. */
  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.port = typeof address === 'object' && address !== null ? address.port : 0
    return `ws://127.0.0.1:${this.port}`
  }

  /** Set the answer for an action. Throw inside to answer with a failure. */
  respond(action: string, responder: Responder): void {
    this.responders.set(action, responder)
  }

  /** Push an event to every connected client. */
  push(event: Record<string, unknown>): void {
    const data = frame(0x1, Buffer.from(JSON.stringify({ self_id: Number(this.selfId), time: Math.floor(Date.now() / 1000), ...event })))
    for (const socket of this.sockets) socket.write(data)
  }

  /** Number of open connections. */
  get open(): number {
    return this.sockets.size
  }

  /** Drop every connection abruptly (runtime crash). */
  dropAll(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Calls of one action. */
  callsOf(action: string): ReceivedCall[] {
    return this.calls.filter(call => call.action === action)
  }

  async close(): Promise<void> {
    this.dropAll()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private onText(socket: Socket, text: string): void {
    const call = JSON.parse(text) as ReceivedCall
    this.calls.push(call)
    const responder = this.responders.get(call.action)
    let reply: Record<string, unknown>
    if (responder === undefined) {
      reply = { status: 'failed', retcode: 1404, message: `unknown action ${call.action}`, echo: call.echo }
    } else {
      try {
        reply = { status: 'ok', retcode: 0, data: responder(call) ?? null, echo: call.echo }
      } catch (error: unknown) {
        reply = { status: 'failed', retcode: 100, message: error instanceof Error ? error.message : String(error), echo: call.echo }
      }
    }
    if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(reply))))
  }
}
