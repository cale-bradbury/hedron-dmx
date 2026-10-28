import * as THREE from 'three'
import {
  BAR_DIRECTION_OPTIONS,
  BarOutput,
  MASTER_PARAMS,
  Rgb,
  clamp01,
  outputGroup,
  pixelSpan,
  readBarMode,
  readNonNegative,
  readPixelCount,
  readRgb,
} from '../../shared/BarStrip'

const DEFAULT_STOPS: Rgb[] = [
  [0, 0, 0],
  [0, 0.3, 1],
  [1, 0, 0.6],
  [1, 1, 1],
]

/**
 * The audio plugin's full spectrum spread across a DMX pixel source, coloured by level through
 * four stops. Reads `fullLevelsData`, which the analyzer has already normalised, curved and smoothed.
 */
export default class BarSpectrum {
  root = new THREE.Group()
  private output = new BarOutput(this.root)
  private levels = new Float32Array(0)
  private stops: Rgb[] = DEFAULT_STOPS
  private labStops: Rgb[] = DEFAULT_STOPS.map(srgbToOklab)

  update({ params, deltaTime }: { params: any; deltaTime: number }) {
    const pixelCount = readPixelCount(params)
    const dt = Math.max(0, deltaTime ?? 0)
    if (this.levels.length !== pixelCount) {
      this.levels = new Float32Array(pixelCount)
    }

    const data: ArrayLike<number> | undefined = (window as any).__HEDRON?.plugins?.['audio-input']
      ?.analyzer?.fullLevelsData
    const binCount = data?.length ?? 0

    // Full isn't a direction, so it lays out left to right.
    const mode = readBarMode(params.mode, 'l2r')
    const layout = mode === 'full' ? 'l2r' : mode

    const lastBin = Math.max(0, binCount - 1)
    const lo = clampInt(params.minBin ?? 1, 0, lastBin)
    const hi = clampInt(params.maxBin ?? 512, lo, lastBin)
    const warp = makeWarp(Number(params.logScale ?? 1) || 0, lo, hi)

    const gain = readNonNegative(params.gain, 1)
    const gamma = Math.max(0.05, Number(params.gamma ?? 1) || 1)
    const release = readNonNegative(params.release, 0.2)
    const useMax = params.useMax !== false
    const oklab = params.oklab === true
    this.readStops(params, oklab)

    this.output.begin(params, 'spectrum', pixelCount)

    for (let p = 0; p < pixelCount; p++) {
      let value = 0
      if (data && binCount > 0) {
        const [t0, t1] = pixelSpan(layout, p, pixelCount)
        const b0 = lo + warp(t0) * (hi - lo)
        const b1 = lo + warp(t1) * (hi - lo)
        value = sampleBins(data, b0, b1, useMax)
      }
      value = Math.pow(clamp01(value * gain), gamma)

      // Instant attack, linear release: `release` is seconds to fall from full to nothing.
      const previous = this.levels[p]
      const level =
        value >= previous || release <= 0 ? value : Math.max(value, previous - dt / release)
      this.levels[p] = level

      const [r, g, b] = this.colorAt(level, oklab)
      // White stays at 0; the stops define the whole colour.
      this.output.write(p, r * 255, g * 255, b * 255)
    }
  }

  private readStops(params: any, oklab: boolean) {
    this.stops = DEFAULT_STOPS.map((fallback, i) => readRgb(params[`color${i}`], fallback))
    if (oklab) this.labStops = this.stops.map(srgbToOklab)
  }

  /** Blends the two stops either side of `level`; stops sit at 0, 1/3, 2/3 and 1. */
  private colorAt(level: number, oklab: boolean): Rgb {
    const scaled = clamp01(level) * 3
    const segment = Math.min(2, Math.floor(scaled))
    const t = scaled - segment
    const stops = oklab ? this.labStops : this.stops
    const a = stops[segment]
    const b = stops[segment + 1]
    const mixed: Rgb = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]
    return oklab ? oklabToSrgb(mixed) : mixed
  }

  destroy() {
    this.output.dispose()
  }

  static getConfig() {
    return {
      title: 'Bar Spectrum',
      description:
        'The full audio spectrum across a DMX pixel source, coloured by level through four stops.',
      category: 'lighting',
      params: [
        ...MASTER_PARAMS,
        outputGroup('spectrum'),
        {
          groupTitle: 'Spectrum',
          params: [
            {
              key: 'minBin',
              title: 'Min FFT Index',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 1024,
            },
            {
              key: 'maxBin',
              title: 'Max FFT Index',
              defaultValue: 512,
              sliderMin: 1,
              sliderMax: 1024,
            },
            {
              key: 'mode',
              title: 'Mode',
              valueType: 'enum' as const,
              defaultValue: 'l2r',
              options: BAR_DIRECTION_OPTIONS,
            },
            {
              key: 'logScale',
              title: 'Log Scale',
              description:
                '0 is linear, 1 is true log frequency; past 1 goes further, below 0 bends the other way',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'useMax',
              title: 'Max of Bins',
              description: 'Off averages the bins each pixel covers instead',
              valueType: 'boolean' as const,
              defaultValue: true,
            },
            {
              key: 'gain',
              title: 'Gain',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 4,
            },
            {
              key: 'gamma',
              title: 'Gamma',
              defaultValue: 1,
              sliderMin: 0.2,
              sliderMax: 4,
            },
            {
              key: 'release',
              title: 'Release (s)',
              description: 'Seconds for a pixel to fall from full to nothing; 0 follows the audio',
              defaultValue: 0.2,
              sliderMin: 0,
              sliderMax: 2,
            },
          ],
        },
        {
          groupTitle: 'Colour',
          params: [
            stopParam(0, '0%'),
            stopParam(1, '33%'),
            stopParam(2, '66%'),
            stopParam(3, '100%'),
            {
              key: 'oklab',
              title: 'Blend in Oklab',
              valueType: 'boolean' as const,
              defaultValue: false,
            },
          ],
        },
      ],
    }
  }
}

function stopParam(index: number, title: string) {
  return {
    key: `color${index}`,
    title,
    valueType: 'rgb' as const,
    defaultValue: DEFAULT_STOPS[index],
  }
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/**
 * Maps a 0–1 position to a 0–1 share of the chosen bins. 0 is linear and 1 is true log
 * frequency (equal pixels per octave); beyond 1 is more extreme, below 0 bends the other way.
 */
function makeWarp(scale: number, lo: number, hi: number): (t: number) => number {
  const a = scale * Math.log(Math.max(hi, 1) / Math.max(lo, 1))
  if (Math.abs(a) < 1e-4) return (t) => t
  const denominator = Math.expm1(a)
  return (t) => Math.expm1(a * t) / denominator
}

/** One pixel's value from the bins it covers; a pixel narrower than a bin interpolates instead. */
function sampleBins(data: ArrayLike<number>, b0: number, b1: number, useMax: boolean): number {
  const last = data.length - 1

  if (b1 - b0 < 1) {
    const centre = Math.min(last, Math.max(0, (b0 + b1) / 2))
    const i = Math.floor(centre)
    const j = Math.min(i + 1, last)
    return data[i] + (data[j] - data[i]) * (centre - i)
  }

  const start = Math.max(0, Math.floor(b0))
  const end = Math.min(last, Math.ceil(b1) - 1)
  let max = 0
  let sum = 0
  for (let i = start; i <= end; i++) {
    const value = data[i]
    if (value > max) max = value
    sum += value
  }
  const count = end - start + 1
  return useMax ? max : count > 0 ? sum / count : 0
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function srgbToOklab(rgb: Rgb): Rgb {
  const r = srgbToLinear(rgb[0])
  const g = srgbToLinear(rgb[1])
  const b = srgbToLinear(rgb[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToSrgb(lab: Rgb): Rgb {
  const l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3)
  const m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3)
  const s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2], 3)
  return [
    clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ]
}
