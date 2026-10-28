import * as THREE from 'three'
import {
  BarOutput,
  MASTER_PARAMS,
  Rgb,
  clamp01,
  outputGroup,
  overlap,
  readNonNegative,
  readPixelCount,
  readRgb,
} from '../../shared/BarStrip'

const CHANNELS = 3
const LN_100 = Math.log(100)
const DEFAULT_COLORS: Rgb[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const DEFAULT_POSITIONS = [0.2, 0.5, 0.8]

interface Channel {
  position: number
  wrap: boolean
  size: number
  maxSweep: number
  fade: number
  color: Rgb
  brightness: number
  motionToBrightness: number
}

/** A head's trail, and where it was last frame so its motion can be measured. */
interface Runner {
  trail: Float32Array
  lastX: number
  lastWrap: boolean
}

/**
 * Three chase heads on a DMX pixel source, each placed by a Position param meant to be driven
 * by an LFO or audio. Heads leave fading trails and add together where they cross.
 */
export default class BarChase {
  root = new THREE.Group()
  private output = new BarOutput(this.root)
  private runners: Runner[] = []
  private rgb = new Float32Array(0)
  private count = 0

  update({ params, deltaTime }: { params: any; deltaTime: number }) {
    const pixelCount = readPixelCount(params)
    const dt = Math.max(0, deltaTime ?? 0)
    if (pixelCount !== this.count) this.reset(pixelCount)
    this.rgb.fill(0)

    for (let c = 0; c < CHANNELS; c++) {
      const channel = readChannel(params, c)
      const trail = this.runners[c].trail
      this.run(this.runners[c], channel, dt)
      const [r, g, b] = channel.color
      for (let p = 0; p < pixelCount; p++) {
        this.rgb[p * 3] += r * trail[p]
        this.rgb[p * 3 + 1] += g * trail[p]
        this.rgb[p * 3 + 2] += b * trail[p]
      }
    }

    this.output.begin(params, 'chase', pixelCount)
    for (let p = 0; p < pixelCount; p++) {
      // White stays at 0; crossing heads add toward white through RGB instead.
      this.output.write(
        p,
        Math.min(1, this.rgb[p * 3]) * 255,
        Math.min(1, this.rgb[p * 3 + 1]) * 255,
        Math.min(1, this.rgb[p * 3 + 2]) * 255,
      )
    }
  }

  private reset(count: number) {
    this.count = count
    this.rgb = new Float32Array(count * 3)
    this.runners = Array.from({ length: CHANNELS }, () => ({
      trail: new Float32Array(count),
      lastX: NaN,
      lastWrap: false,
    }))
  }

  private run(runner: Runner, channel: Channel, dt: number) {
    const count = this.count
    // Wrapping laps the bar once per unit of Position; otherwise 0 and 1 are the end pixels.
    const x = channel.wrap
      ? (channel.position - Math.floor(channel.position)) * count + 0.5
      : clamp01(channel.position) * (count - 1) + 0.5

    // With nothing to move from (first frame, or wrap just toggled) the head starts still.
    if (!Number.isFinite(runner.lastX) || runner.lastWrap !== channel.wrap) {
      runner.lastX = x
    }
    let moved = x - runner.lastX
    if (channel.wrap) moved -= Math.round(moved / count) * count
    runner.lastX = x
    runner.lastWrap = channel.wrap

    const trail = runner.trail
    const fade = channel.fade > 0 ? Math.exp((-dt * LN_100) / channel.fade) : 0
    for (let p = 0; p < count; p++) trail[p] *= fade

    // At ratio 1 the head is only at full brightness moving at least a pixel a frame.
    const speed = Math.min(1, Math.abs(moved))
    const head = channel.brightness * (1 - channel.motionToBrightness * (1 - speed))
    if (head <= 0) return

    // The head sweeps from where it was to where it is, so fast moves leave no gaps; a move
    // longer than Max Sweep is a jump instead, like a sawtooth snapping back to the start.
    const sweep = Math.abs(moved) <= channel.maxSweep * count ? moved : 0
    const half = channel.size / 2
    const from = Math.min(x - sweep, x) - half
    const to = Math.max(x - sweep, x) + half
    for (let p = 0; p < count; p++) {
      let cover = overlap(p, from, to)
      if (channel.wrap) {
        cover += overlap(p + count, from, to) + overlap(p - count, from, to)
      }
      const lit = head * Math.min(1, cover)
      if (lit > trail[p]) trail[p] = lit
    }
  }

  destroy() {
    this.output.dispose()
  }

  static getConfig() {
    return {
      title: 'Bar Chase',
      description:
        'Three chase heads with fading trails across a DMX pixel source; drive each Position from an LFO or audio.',
      category: 'lighting',
      params: [
        ...MASTER_PARAMS,
        outputGroup('chase'),
        channelGroup(0),
        channelGroup(1),
        channelGroup(2),
      ],
    }
  }
}

/** Reads one channel's params, clamping anything a user has pushed past its slider range. */
function readChannel(params: any, c: number): Channel {
  const key = `ch${c + 1}`
  return {
    position: Number(params[`${key}.position`] ?? DEFAULT_POSITIONS[c]) || 0,
    wrap: params[`${key}.wrap`] === true,
    size: Math.max(0.05, readNonNegative(params[`${key}.size`], 1)),
    maxSweep: clamp01(params[`${key}.maxSweep`] ?? 1),
    fade: readNonNegative(params[`${key}.fade`], 0.5),
    color: readRgb(params[`${key}.color`], DEFAULT_COLORS[c]),
    brightness: clamp01(params[`${key}.brightness`] ?? 1),
    motionToBrightness: clamp01(params[`${key}.motionToBrightness`] ?? 0),
  }
}

function channelGroup(c: number) {
  const key = `ch${c + 1}`
  return {
    groupTitle: `Channel ${c + 1}`,
    params: [
      {
        key: `${key}.position`,
        title: 'Position',
        description: 'Where the head sits along the bar; drive it from an LFO or audio',
        defaultValue: DEFAULT_POSITIONS[c],
        sliderMin: 0,
        sliderMax: 1,
      },
      {
        key: `${key}.wrap`,
        title: 'Wrap',
        description:
          'Off: 0 and 1 are the end pixels. On: each whole unit of Position laps the bar',
        valueType: 'boolean' as const,
        defaultValue: false,
      },
      {
        key: `${key}.size`,
        title: 'Size (px)',
        defaultValue: 1,
        sliderMin: 0.25,
        sliderMax: 8,
      },
      {
        key: `${key}.maxSweep`,
        title: 'Max Sweep',
        description:
          'Longest move in one frame, as a share of the bar, drawn as a streak; longer moves jump without lighting the gap',
        defaultValue: 1,
        sliderMin: 0,
        sliderMax: 1,
      },
      {
        key: `${key}.fade`,
        title: 'Fade (s)',
        description: 'Seconds for the trail to fade to 1%; 0 leaves no trail',
        defaultValue: 0.5,
        sliderMin: 0,
        sliderMax: 4,
      },
      {
        key: `${key}.color`,
        title: 'Color',
        valueType: 'rgb' as const,
        defaultValue: DEFAULT_COLORS[c],
      },
      {
        key: `${key}.brightness`,
        title: 'Brightness',
        defaultValue: 1,
        sliderMin: 0,
        sliderMax: 1,
      },
      {
        key: `${key}.motionToBrightness`,
        title: 'Motion → Brightness',
        description:
          'At 1 the head is only at full brightness while moving at least a pixel a frame',
        defaultValue: 0,
        sliderMin: 0,
        sliderMax: 1,
      },
    ],
  }
}
