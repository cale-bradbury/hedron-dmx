import * as THREE from 'three'
import {
  BAR_MODE_OPTIONS,
  BarMode,
  BarOutput,
  MASTER_PARAMS,
  Rgb,
  clamp01,
  outputGroup,
  overlap,
  readBarMode,
  readNonNegative,
  readPixelCount,
  readRgb,
} from '../../shared/BarStrip'

const CHANNELS = 3
const DEFAULT_COLORS: Rgb[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const DEFAULT_MODES: BarMode[] = ['l2r', 'midOut', 'r2l']

interface Channel {
  value: number
  mode: BarMode
  range: number
  color: Rgb
  brightnessFromValue: boolean
  softTip: boolean
  release: number
  peakHold: number
  peakFalloff: number
}

/** Smoothed meter state, carried between frames. */
interface Meter {
  level: number
  peak: number
  hold: number
}

/**
 * Three overlaid VU meters across a DMX pixel source. Channels add, so the default red,
 * green and blue mix toward white where they overlap.
 */
export default class BarVU {
  root = new THREE.Group()
  private output = new BarOutput(this.root)
  private meters: Meter[] = Array.from({ length: CHANNELS }, () => ({ level: 0, peak: 0, hold: 0 }))
  private rgb = new Float32Array(0)
  // Lit ranges for the channel being drawn, in pixels, as two [start, end] pairs.
  private fillSpans = new Float32Array(4)
  private peakSpans = new Float32Array(4)

  update({ params, deltaTime }: { params: any; deltaTime: number }) {
    const pixelCount = readPixelCount(params)
    const dt = Math.max(0, deltaTime ?? 0)

    if (this.rgb.length !== pixelCount * 3) {
      this.rgb = new Float32Array(pixelCount * 3)
    } else {
      this.rgb.fill(0)
    }

    for (let c = 0; c < CHANNELS; c++) {
      const channel = readChannel(params, c)
      advanceMeter(this.meters[c], channel, dt)
      this.drawChannel(channel, this.meters[c], pixelCount)
    }

    this.output.begin(params, 'vu', pixelCount)
    for (let p = 0; p < pixelCount; p++) {
      // White stays at 0; the RGB channels adding up is how this reaches white.
      this.output.write(
        p,
        Math.min(1, this.rgb[p * 3]) * 255,
        Math.min(1, this.rgb[p * 3 + 1]) * 255,
        Math.min(1, this.rgb[p * 3 + 2]) * 255,
      )
    }
  }

  private drawChannel(channel: Channel, meter: Meter, count: number) {
    if (channel.range <= 0) return
    // Pixels this channel may light, given its range.
    const reach = channel.range * count

    if (channel.mode === 'full') {
      // No tip to hold, so the peak becomes brightness: flash on a hit, hold, then fade.
      const centre = count / 2
      setSpans(this.fillSpans, centre - reach / 2, centre + reach / 2, 0, 0)
      this.accumulate(channel, count, Math.max(meter.level, meter.peak), false)
      return
    }

    const fill = meter.level * reach
    const peak = meter.peak * reach
    fillSpansFor(channel.mode, fill, count, this.fillSpans)

    // A peak level with the fill would only re-light the tip, so it's drawn once it separates.
    const showPeak = peak > fill
    if (showPeak) peakSpansFor(channel.mode, peak, count, this.peakSpans)

    const fillBrightness = channel.brightnessFromValue ? meter.level : 1
    this.accumulate(channel, count, fillBrightness, showPeak)
  }

  private accumulate(channel: Channel, count: number, fillBrightness: number, withPeak: boolean) {
    const [r, g, b] = channel.color
    for (let p = 0; p < count; p++) {
      const fill = coverage(this.fillSpans, p, channel.softTip) * fillBrightness
      const peak = withPeak ? coverage(this.peakSpans, p, channel.softTip) : 0
      // Max within a channel so the peak never doubles the tip; channels then add.
      const weight = Math.max(fill, peak)
      if (weight <= 0) continue
      this.rgb[p * 3] += r * weight
      this.rgb[p * 3 + 1] += g * weight
      this.rgb[p * 3 + 2] += b * weight
    }
  }

  destroy() {
    this.output.dispose()
  }

  static getConfig() {
    return {
      title: 'Bar VU',
      description:
        'Three overlaid VU meters across a DMX pixel source; bind each Value to an audio band.',
      category: 'lighting',
      params: [
        ...MASTER_PARAMS,
        outputGroup('vu'),
        channelGroup(0),
        channelGroup(1),
        channelGroup(2),
      ],
    }
  }
}

/** Instant attack with linear release, and a peak that rides up, holds, then falls. */
function advanceMeter(meter: Meter, channel: Channel, dt: number) {
  // Release is the seconds taken to fall the whole bar.
  if (channel.value >= meter.level || channel.release <= 0) {
    meter.level = channel.value
  } else {
    meter.level = Math.max(channel.value, meter.level - dt / channel.release)
  }

  if (meter.level >= meter.peak) {
    meter.peak = meter.level
    meter.hold = channel.peakHold
  } else if (meter.hold > 0) {
    meter.hold -= dt
  } else if (channel.peakFalloff <= 0) {
    meter.peak = meter.level
  } else {
    meter.peak = Math.max(meter.level, meter.peak - dt / channel.peakFalloff)
  }
}

function setSpans(out: Float32Array, a0: number, b0: number, a1: number, b1: number) {
  out[0] = a0
  out[1] = b0
  out[2] = a1
  out[3] = b1
}

/** The lit length `fill` laid out from the mode's origin; symmetric modes split it in two. */
function fillSpansFor(mode: BarMode, fill: number, count: number, out: Float32Array) {
  const centre = count / 2
  switch (mode) {
    case 'r2l':
      return setSpans(out, count - fill, count, 0, 0)
    case 'midOut':
      return setSpans(out, centre - fill / 2, centre + fill / 2, 0, 0)
    case 'outMid':
      return setSpans(out, 0, fill / 2, count - fill / 2, count)
    default:
      return setSpans(out, 0, fill, 0, 0)
  }
}

/** One-pixel peak markers sitting just inside the leading edge of a fill of length `peak`. */
function peakSpansFor(mode: BarMode, peak: number, count: number, out: Float32Array) {
  const centre = count / 2
  const half = peak / 2
  switch (mode) {
    case 'r2l':
      return setSpans(out, count - peak, count - peak + 1, 0, 0)
    case 'midOut':
      return setSpans(out, centre + half - 1, centre + half, centre - half, centre - half + 1)
    case 'outMid':
      return setSpans(out, half - 1, half, count - half, count - half + 1)
    default:
      return setSpans(out, peak - 1, peak, 0, 0)
  }
}

/** How much of pixel `p` the spans cover; a hard tip lights a pixel only when mostly covered. */
function coverage(spans: Float32Array, p: number, soft: boolean): number {
  const lit = Math.min(1, overlap(p, spans[0], spans[1]) + overlap(p, spans[2], spans[3]))
  return soft ? lit : lit >= 0.5 ? 1 : 0
}

/** Reads one channel's params, clamping anything a user has pushed past its slider range. */
function readChannel(params: any, c: number): Channel {
  const key = `ch${c + 1}`
  return {
    value: clamp01(params[`${key}.value`] ?? 0),
    mode: readBarMode(params[`${key}.mode`], DEFAULT_MODES[c]),
    range: clamp01(params[`${key}.range`] ?? 1),
    color: readRgb(params[`${key}.color`], DEFAULT_COLORS[c]),
    brightnessFromValue: params[`${key}.brightnessFromValue`] === true,
    softTip: params[`${key}.softTip`] !== false,
    release: readNonNegative(params[`${key}.release`], 0.3),
    peakHold: readNonNegative(params[`${key}.peakHold`], 0.5),
    peakFalloff: readNonNegative(params[`${key}.peakFalloff`], 1),
  }
}

function channelGroup(c: number) {
  const key = `ch${c + 1}`
  return {
    groupTitle: `Channel ${c + 1}`,
    params: [
      {
        key: `${key}.value`,
        title: 'Value',
        defaultValue: 0,
        sliderMin: 0,
        sliderMax: 1,
      },
      {
        key: `${key}.mode`,
        title: 'Mode',
        valueType: 'enum' as const,
        defaultValue: DEFAULT_MODES[c],
        options: BAR_MODE_OPTIONS,
      },
      {
        key: `${key}.range`,
        title: 'Range',
        description: "Share of the bar this channel can fill, from its mode's origin",
        defaultValue: 1,
        sliderMin: 0,
        sliderMax: 1,
      },
      {
        key: `${key}.color`,
        title: 'Color',
        valueType: 'rgb' as const,
        defaultValue: DEFAULT_COLORS[c],
      },
      {
        key: `${key}.brightnessFromValue`,
        title: 'Brightness From Value',
        valueType: 'boolean' as const,
        defaultValue: false,
      },
      {
        key: `${key}.softTip`,
        title: 'Soft Tip',
        valueType: 'boolean' as const,
        defaultValue: true,
      },
      {
        key: `${key}.release`,
        title: 'Release (s)',
        description: 'Seconds for the bar to fall its full length; 0 follows the value',
        defaultValue: 0.3,
        sliderMin: 0,
        sliderMax: 2,
      },
      {
        key: `${key}.peakHold`,
        title: 'Peak Hold (s)',
        defaultValue: 0.5,
        sliderMin: 0,
        sliderMax: 3,
      },
      {
        key: `${key}.peakFalloff`,
        title: 'Peak Falloff (s)',
        description: 'Seconds for the peak to fall its full length; 0 drops it straight to the bar',
        defaultValue: 1,
        sliderMin: 0,
        sliderMax: 5,
      },
    ],
  }
}
