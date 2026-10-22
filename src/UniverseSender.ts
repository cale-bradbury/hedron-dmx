import type { DmxProtocol } from './types'
import type { UniverseSet } from './UniverseSet'

/** ~44 Hz, comfortably above the DMX512 refresh floor and independent of render fps. */
export const SEND_INTERVAL_MS = 23

export interface FrameContext {
  protocol: DmxProtocol
  lerpSpeed: number
  /** ArtNet/sACN destination; empty means broadcast (ArtNet) or multicast (sACN). */
  target: string
  /** False while there's nothing patched, so an idle plugin never transmits onto the network. */
  enabled: boolean
}

/** The transport, which lives in the plugin's main process half. */
export interface UniverseOutput {
  send: (frame: FrameContext, universe: number, bytes: Uint8Array) => void
  /** Stops all output, including any keep-alive resends. */
  stop: () => void
}

/**
 * Drives output at a fixed rate: composite the frame, then ship only the universes
 * whose bytes changed, so render fps and wire fps are independent.
 */
export class UniverseSender {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastProtocol: DmxProtocol | null = null
  private lastLerpSpeed: number | null = null
  private lastTarget: string | null = null
  private wasEnabled = false

  constructor(
    private universes: UniverseSet,
    private prepareFrame: () => FrameContext,
    private output: UniverseOutput,
  ) {}

  public start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), SEND_INTERVAL_MS)
  }

  public stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    // Output is left as is, so a reload hands over without a blackout flicker
    this.wasEnabled = false
  }

  private tick(): void {
    const context = this.prepareFrame()

    if (!context.enabled) {
      if (this.wasEnabled) this.output.stop()
      this.wasEnabled = false
      return
    }

    // A transport change alters how existing bytes are transmitted, not the bytes
    // themselves, so force a resend rather than waiting for the next value change.
    if (
      context.protocol !== this.lastProtocol ||
      context.lerpSpeed !== this.lastLerpSpeed ||
      context.target !== this.lastTarget ||
      !this.wasEnabled
    ) {
      this.universes.markAllDirty()
      this.lastProtocol = context.protocol
      this.lastLerpSpeed = context.lerpSpeed
      this.lastTarget = context.target
      this.wasEnabled = true
    }

    for (const { universe, bytes } of this.universes.takeDirty()) {
      this.output.send(context, universe, bytes)
    }
  }
}
