// ArtNet and sACN (E1.31) output over UDP, from the Electron main process.
import dgram from 'dgram'
import { randomUUID } from 'crypto'

export type NetworkProtocol = 'artnet' | 'sacn'

const DMX_SLOTS = 512
const ARTNET_PORT = 6454
const SACN_PORT = 5568
const ARTNET_BROADCAST = '255.255.255.255'
// Receivers treat a silent universe as lost (sACN after 2.5s), so unchanged ones are re-sent
const KEEPALIVE_MS = 800

/** An ArtDmx packet; `universe` is the 15-bit Port-Address (Net, Sub-Net, Universe). */
export const artnetPacket = (universe: number, data: Uint8Array, sequence: number): Buffer => {
  const packet = Buffer.alloc(18 + DMX_SLOTS)
  packet.write('Art-Net\0', 0, 'ascii')
  packet.writeUInt16LE(0x5000, 8) // OpDmx
  packet.writeUInt16BE(14, 10) // Protocol version
  packet[12] = sequence
  packet[13] = 0 // Physical port
  packet[14] = universe & 0xff // SubUni
  packet[15] = (universe >> 8) & 0x7f // Net
  packet.writeUInt16BE(DMX_SLOTS, 16)
  packet.set(data.subarray(0, DMX_SLOTS), 18)
  return packet
}

/** An E1.31 data packet with a full 512-slot universe; sACN universes run from 1. */
export const sacnPacket = (
  universe: number,
  data: Uint8Array,
  sequence: number,
  cid: Buffer,
  sourceName: string,
): Buffer => {
  const packet = Buffer.alloc(126 + DMX_SLOTS)

  // Root layer
  packet.writeUInt16BE(0x0010, 0) // Preamble size
  packet.writeUInt16BE(0x0000, 2) // Post-amble size
  Buffer.from('ASC-E1.17\0\0\0', 'ascii').copy(packet, 4)
  packet.writeUInt16BE(0x7000 | (packet.length - 16), 16)
  packet.writeUInt32BE(0x00000004, 18) // VECTOR_ROOT_E131_DATA
  cid.copy(packet, 22)

  // Framing layer
  packet.writeUInt16BE(0x7000 | (packet.length - 38), 38)
  packet.writeUInt32BE(0x00000002, 40) // VECTOR_E131_DATA_PACKET
  packet.write(sourceName.slice(0, 63), 44, 'utf8')
  packet[108] = 100 // Priority
  packet.writeUInt16BE(0, 109) // Synchronization address
  packet[111] = sequence
  packet[112] = 0 // Options
  packet.writeUInt16BE(universe, 113)

  // DMP layer
  packet.writeUInt16BE(0x7000 | (packet.length - 115), 115)
  packet[117] = 0x02 // VECTOR_DMP_SET_PROPERTY
  packet[118] = 0xa1 // Address and data type
  packet.writeUInt16BE(0x0000, 119) // First property address
  packet.writeUInt16BE(0x0001, 121) // Address increment
  packet.writeUInt16BE(DMX_SLOTS + 1, 123) // Property value count, start code included
  packet[125] = 0x00 // DMX start code
  packet.set(data.subarray(0, DMX_SLOTS), 126)
  return packet
}

const sacnMulticastAddress = (universe: number) =>
  `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`

const uuidBytes = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex')

interface LastFrame {
  protocol: NetworkProtocol
  universe: number
  data: Uint8Array
  target: string
  sentAt: number
}

export class NetworkSender {
  private socket: dgram.Socket | null = null
  private sequences = new Map<string, number>()
  private lastFrames = new Map<number, LastFrame>()
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private cid = uuidBytes(randomUUID())
  private packetsSent = 0
  private lastError: string | null = null

  private getSocket(): dgram.Socket {
    if (this.socket) return this.socket
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (error) => {
      this.lastError = error.message
      console.warn('[DMX] Network socket error:', error.message)
    })
    socket.bind(() => socket.setBroadcast(true))
    this.socket = socket

    this.keepAlive = setInterval(() => {
      const now = Date.now()
      for (const frame of this.lastFrames.values()) {
        if (now - frame.sentAt >= KEEPALIVE_MS) this.transmit(frame)
      }
    }, KEEPALIVE_MS / 4)
    return socket
  }

  private nextSequence(key: string): number {
    // ArtNet treats 0 as "sequencing off", so both protocols cycle 1–255
    const next = ((this.sequences.get(key) ?? 0) % 255) + 1
    this.sequences.set(key, next)
    return next
  }

  private transmit(frame: LastFrame): void {
    const socket = this.getSocket()
    frame.sentAt = Date.now()

    let packet: Buffer
    let address: string
    let port: number
    if (frame.protocol === 'artnet') {
      packet = artnetPacket(frame.universe, frame.data, this.nextSequence(`a${frame.universe}`))
      address = frame.target || ARTNET_BROADCAST
      port = ARTNET_PORT
    } else {
      const universe = frame.universe + 1
      packet = sacnPacket(
        universe,
        frame.data,
        this.nextSequence(`s${universe}`),
        this.cid,
        'Hedron',
      )
      address = frame.target || sacnMulticastAddress(universe)
      port = SACN_PORT
    }

    socket.send(packet, port, address, (error) => {
      if (error) {
        this.lastError = error.message
      } else {
        this.packetsSent++
      }
    })
  }

  /** Sends a universe now and keeps re-sending it until it changes or output moves elsewhere. */
  public send(protocol: NetworkProtocol, universe: number, data: Uint8Array, target: string): void {
    // Switching protocol or target retires every frame still being kept alive the old way
    for (const [key, frame] of this.lastFrames) {
      if (frame.protocol !== protocol || frame.target !== target) this.lastFrames.delete(key)
    }
    const frame: LastFrame = { protocol, universe, data: new Uint8Array(data), target, sentAt: 0 }
    this.lastFrames.set(universe, frame)
    this.transmit(frame)
  }

  /** Stops sending to the network, e.g. when output switches to USB. */
  public stop(): void {
    this.lastFrames.clear()
  }

  public describe(): object[] {
    if (this.lastFrames.size === 0 && this.packetsSent === 0) return []
    const frames = [...this.lastFrames.values()]
    const protocol = frames[0]?.protocol
    return [
      {
        name: protocol === 'sacn' ? 'sACN (E1.31)' : protocol === 'artnet' ? 'ArtNet' : 'Network',
        status: this.lastError ? `Error: ${this.lastError}` : 'Sending',
        path: frames[0]?.target || (protocol === 'sacn' ? 'multicast' : ARTNET_BROADCAST),
        lastSent: `${this.packetsSent} packets, universes ${frames.map((f) => f.universe).join(', ') || 'none'}`,
      },
    ]
  }

  public close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    this.lastFrames.clear()
    this.socket?.close()
    this.socket = null
  }
}
