import * as THREE from 'three'
import { source, type PixelSource } from '@hedron-plugins/dmx-lighting'

export type Rgb = [number, number, number]

/** How a bar fills: from one end, from the centre, from both ends, or all at once. */
export type BarMode = 'l2r' | 'r2l' | 'midOut' | 'outMid' | 'full'

export const BAR_DIRECTION_OPTIONS = [
  { value: 'l2r', label: 'Left to Right' },
  { value: 'r2l', label: 'Right to Left' },
  { value: 'midOut', label: 'Middle Out' },
  { value: 'outMid', label: 'Out to Middle' },
]

export const BAR_MODE_OPTIONS = [...BAR_DIRECTION_OPTIONS, { value: 'full', label: 'Full Bar' }]

export function readBarMode(value: unknown, fallback: BarMode = 'l2r'): BarMode {
  return BAR_MODE_OPTIONS.some((option) => option.value === value) ? (value as BarMode) : fallback
}

/**
 * Where a pixel sits along a directional layout, as a [start, end] range from 0 at the origin
 * to 1 at the far end. Symmetric modes mirror, so both halves share positions.
 */
export function pixelSpan(mode: BarMode, index: number, count: number): [number, number] {
  const x0 = index / count
  const x1 = (index + 1) / count
  switch (mode) {
    case 'r2l':
      return [1 - x1, 1 - x0]
    case 'midOut':
      return centreSpan(x0, x1)
    case 'outMid': {
      const [a, b] = centreSpan(x0, x1)
      return [1 - b, 1 - a]
    }
    default:
      return [x0, x1]
  }
}

function centreSpan(x0: number, x1: number): [number, number] {
  const d0 = Math.abs(x0 - 0.5) * 2
  const d1 = Math.abs(x1 - 0.5) * 2
  // A pixel straddling the centre covers the origin itself.
  if (x0 < 0.5 && x1 > 0.5) return [0, Math.max(d0, d1)]
  return [Math.min(d0, d1), Math.max(d0, d1)]
}

/** How much of pixel `p` (covering p to p + 1) the range [a, b] lights. */
export function overlap(p: number, a: number, b: number): number {
  const lit = Math.min(p + 1, b) - Math.max(p, a)
  return lit > 0 ? lit : 0
}

/** Clamps to 0–1, reading anything non-numeric (NaN included) as 0. */
export function clamp01(value: unknown): number {
  const n = Number(value)
  return n > 0 ? (n < 1 ? n : 1) : 0
}

/** Reads a param that can't go below 0, such as a time in seconds. */
export function readNonNegative(value: unknown, fallback: number): number {
  return Math.max(0, Number(value ?? fallback) || 0)
}

/** Reads an rgb param as clamped 0–1 channels, falling back when it's missing or malformed. */
export function readRgb(value: unknown, fallback: Rgb): Rgb {
  return Array.isArray(value) ? [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])] : fallback
}

export function readPixelCount(params: any): number {
  const count = Math.round(Number(params.pixelCount ?? 28))
  return Number.isFinite(count) ? Math.max(1, Math.min(512, count)) : 28
}

/** Master hue shift and brightness; every bar sketch lists these first, above its groups. */
export const MASTER_PARAMS = [
  {
    key: 'hueShift',
    title: 'Hue Shift',
    description: "Rotates every colour's hue; 1 is a full turn, and values past it keep turning",
    defaultValue: 0,
    sliderMin: 0,
    sliderMax: 1,
  },
  {
    key: 'brightness',
    title: 'Brightness',
    defaultValue: 1,
    sliderMin: 0,
    sliderMax: 1,
  },
]

/** The source name, pixel count and preview toggle that `BarOutput.begin` reads. */
export function outputGroup(defaultSourceName: string) {
  return {
    groupTitle: 'Output',
    params: [
      {
        key: 'sourceName',
        title: 'Source Name',
        valueType: 'string' as const,
        defaultValue: defaultSourceName,
      },
      {
        key: 'pixelCount',
        title: 'Pixels',
        defaultValue: 28,
        sliderMin: 1,
        sliderMax: 170,
      },
      {
        key: 'showPreview',
        title: 'Show Preview',
        valueType: 'boolean' as const,
        defaultValue: true,
      },
    ],
  }
}

/**
 * Sends a bar sketch's pixels to its DMX source and on-screen preview, applying the master
 * hue shift and brightness on the way so every bar sketch treats them the same.
 */
export class BarOutput {
  private preview: BarPreview
  private source: PixelSource | undefined
  private hueShift = 0
  private brightness = 1
  private shifted = new Float32Array(3)

  constructor(root: THREE.Group) {
    this.preview = new BarPreview(root)
  }

  /** Call once a frame, before writing that frame's pixels. */
  begin(params: any, defaultSourceName: string, pixelCount: number) {
    // source is undefined while the DMX plugin isn't loaded; the preview still runs.
    this.source = source?.(params.sourceName || defaultSourceName, pixelCount)
    this.preview.resize(params.showPreview !== false ? pixelCount : 0)
    const shift = Number(params.hueShift ?? 0) || 0
    this.hueShift = shift - Math.floor(shift)
    this.brightness = readNonNegative(params.brightness, 1)
  }

  /** Writes one pixel from 0–255 values. White is dimmed with the rest but has no hue to shift. */
  write(index: number, r: number, g: number, b: number, w = 0, intensity = 255) {
    if (this.hueShift !== 0) {
      rotateHue(r, g, b, this.hueShift, this.shifted)
      r = this.shifted[0]
      g = this.shifted[1]
      b = this.shifted[2]
    }
    const k = this.brightness
    r = clampByte(r * k)
    g = clampByte(g * k)
    b = clampByte(b * k)
    w = clampByte(w * k)
    this.source?.set(index, r, g, b, w, intensity)
    this.preview.paint(index, Math.min(255, r + w), Math.min(255, g + w), Math.min(255, b + w))
  }

  dispose() {
    this.preview.dispose()
  }
}

function clampByte(value: number): number {
  return value > 0 ? (value < 255 ? value : 255) : 0
}

/** Rotates hue in HSV, keeping value and chroma, so a shift never brightens or greys a colour. */
function rotateHue(r: number, g: number, b: number, turn: number, out: Float32Array) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if (chroma <= 0) {
    // Greys, white included, have no hue to rotate.
    return assign(out, r, g, b)
  }

  let hue: number
  if (max === r) hue = ((g - b) / chroma + 6) % 6
  else if (max === g) hue = (b - r) / chroma + 2
  else hue = (r - g) / chroma + 4
  hue = hue / 6 + turn
  hue = (hue - Math.floor(hue)) * 6

  const sector = Math.floor(hue)
  const rise = min + chroma * (hue - sector)
  const fall = max - chroma * (hue - sector)
  switch (sector) {
    case 0:
      return assign(out, max, rise, min)
    case 1:
      return assign(out, fall, max, min)
    case 2:
      return assign(out, min, max, rise)
    case 3:
      return assign(out, min, fall, max)
    case 4:
      return assign(out, rise, min, max)
    default:
      return assign(out, max, min, fall)
  }
}

function assign(out: Float32Array, r: number, g: number, b: number) {
  out[0] = r
  out[1] = g
  out[2] = b
}

/** On-screen copy of the bar, so a pattern can be checked without the rig. */
class BarPreview {
  private meshes: THREE.Mesh[] = []

  constructor(private root: THREE.Group) {}

  /** Rebuilds the strip when the pixel count changes; 0 removes it. */
  resize(pixelCount: number) {
    if (pixelCount === this.meshes.length) return
    this.dispose()

    const width = 8 / pixelCount
    for (let p = 0; p < pixelCount; p++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 0.9, width * 3),
        new THREE.MeshBasicMaterial({ color: 0x000000 }),
      )
      mesh.position.x = -4 + width * (p + 0.5)
      this.meshes.push(mesh)
      this.root.add(mesh)
    }
  }

  /** Colours one pixel from 0–255 values. */
  paint(index: number, r: number, g: number, b: number) {
    const mesh = this.meshes[index]
    if (!mesh) return
    ;(mesh.material as THREE.MeshBasicMaterial).color.setRGB(r / 255, g / 255, b / 255)
  }

  dispose() {
    for (const mesh of this.meshes) {
      this.root.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.meshes = []
  }
}
