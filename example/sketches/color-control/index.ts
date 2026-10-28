import * as THREE from 'three'
import { source } from '@hedron-plugins/dmx-lighting'

enum MotionAlgorithm {
  Static = 'static',
  Rotating = 'rotating',
  Breathing = 'breathing',
  Pulsing = 'pulsing',
  Wave = 'wave',
}

const MOTION_ALGO_OPTIONS = Object.entries(MotionAlgorithm).map(([key, value]) => ({
  value,
  label: key,
}))

/** Palette rules from colour theory, each giving four colours from one base. */
enum PaletteAlgorithm {
  Monochromatic = 'monochromatic',
  Analogous = 'analogous',
  Complementary = 'complementary',
  SplitComplementary = 'split_complementary',
  Triadic = 'triadic',
  Tetradic = 'tetradic',
  Square = 'square',
  Compound = 'compound',
}

const PALETTE_ALGO_OPTIONS = Object.entries(PaletteAlgorithm).map(([key, value]) => ({
  value,
  label: key.replace(/([A-Z])/g, ' $1').trim(),
}))

/** Hue, saturation and value, all 0–1. */
interface Hsv {
  hue: number
  saturation: number
  brightness: number
}

type Palette = [Hsv, Hsv, Hsv, Hsv]

interface Algorithms {
  palette: PaletteAlgorithm
  motion: MotionAlgorithm
}

interface Params {
  baseHue: number
  baseSaturation: number
  baseBrightness: number
  paletteAlgorithm: PaletteAlgorithm
  paletteSpread: number
  paletteContrast: number
  colorCondense: number
  motionAlgorithm: MotionAlgorithm
  motionPhaseA: number
  motionPhaseB: number
  motionPhaseMix: number
  motionIntensity: number
  transitionTime: number
  showColorSpheres: boolean
  enableDMX: boolean
  dmxSource: string
  dmxBrightness: number
}

// A twelfth of the wheel, 30°.
const HUE_STEP = 1 / 12

/**
 * Builds a four-colour palette from a base colour and a colour-theory rule, animates it from
 * phase inputs, and writes it to a four-pixel DMX source.
 */
export default class ColorControl {
  root = new THREE.Group()
  private previous: Algorithms = {
    palette: PaletteAlgorithm.Monochromatic,
    motion: MotionAlgorithm.Static,
  }
  private current: Algorithms = this.previous
  private transitionProgress = 1
  private colorSpheres: THREE.Mesh[] = []

  constructor() {
    for (let i = 0; i < 4; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      )
      sphere.position.x = (i - 1.5) * 1.5
      this.root.add(sphere)
      this.colorSpheres.push(sphere)
    }
  }

  update({ params, deltaTime }: { params: Params; deltaTime: number }) {
    const phase =
      params.motionPhaseA * (1 - params.motionPhaseMix) +
      params.motionPhaseB * params.motionPhaseMix

    // A change waits for any running transition, then blends from everything currently showing.
    const requested: Algorithms = {
      palette: params.paletteAlgorithm,
      motion: params.motionAlgorithm,
    }
    if (
      this.transitionProgress >= 1 &&
      (requested.palette !== this.current.palette || requested.motion !== this.current.motion)
    ) {
      this.previous = this.current
      this.current = requested
      this.transitionProgress = 0
    }

    if (this.transitionProgress < 1) {
      const time = Number(params.transitionTime) || 0
      this.transitionProgress =
        time > 0 ? Math.min(1, this.transitionProgress + deltaTime / time) : 1
    }

    const from = this.render(this.previous, params, phase)
    const to = this.render(this.current, params, phase)
    const t = easeInOutCubic(this.transitionProgress)
    const colors = applyCondense(
      from.map((color, i) => interpolateColor(color, to[i], t)) as Palette,
      params.colorCondense,
    )
    const rgb = colors.map(({ hue, saturation, brightness }) =>
      hsv2rgb(hue, saturation, brightness),
    )

    this.colorSpheres.forEach((sphere, i) => {
      sphere.visible = params.showColorSpheres
      ;(sphere.material as THREE.MeshBasicMaterial).color.setRGB(...rgb[i])
    })

    // One pixel per colour; mappings in the DMX panel route them to lights.
    // source is undefined while the DMX plugin isn't loaded.
    if (params.enableDMX && source) {
      const pixels = source(params.dmxSource || 'color', 4)
      const scale = 255 * (params.dmxBrightness || 0)
      const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value * scale)))
      rgb.forEach(([r, g, b], i) => {
        // The white channel carries what all three share.
        const w = Math.min(r, g, b)
        pixels.set(i, byte(r - w), byte(g - w), byte(b - w), byte(w), 255)
      })
    }
  }

  private render(algorithms: Algorithms, params: Params, phase: number): Palette {
    const palette = generatePalette(
      algorithms.palette,
      params.baseHue,
      params.baseSaturation,
      params.baseBrightness,
      params.paletteSpread,
      params.paletteContrast,
    )
    return applyMotion(palette, algorithms.motion, phase, params.motionIntensity)
  }

  destroy() {
    for (const sphere of this.colorSpheres) {
      this.root.remove(sphere)
      sphere.geometry.dispose()
      ;(sphere.material as THREE.Material).dispose()
    }
    this.colorSpheres = []
  }

  static getConfig() {
    return {
      title: 'Color Control',
      description: 'A four-colour palette from colour-theory rules, animated and sent to DMX.',
      category: 'lighting',
      params: [
        {
          groupTitle: 'Base Color',
          params: [
            {
              key: 'baseHue',
              title: 'Base Hue',
              defaultValue: 0,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'baseSaturation',
              title: 'Base Saturation',
              defaultValue: 0.8,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'baseBrightness',
              title: 'Base Brightness',
              defaultValue: 0.8,
              sliderMin: 0,
              sliderMax: 1,
            },
          ],
        },
        {
          groupTitle: 'Palette Generation',
          params: [
            {
              key: 'paletteAlgorithm',
              title: 'Palette Algorithm',
              valueType: 'enum' as const,
              defaultValue: PaletteAlgorithm.Analogous,
              options: PALETTE_ALGO_OPTIONS,
            },
            {
              key: 'paletteSpread',
              title: 'Color Spread',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 2,
            },
            {
              key: 'paletteContrast',
              title: 'Contrast',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 2,
            },
            {
              key: 'colorCondense',
              title: 'Color Condense',
              description:
                'Folds the four colours into two pairs: below 0 repeats the first pair, above 0 the second',
              defaultValue: 0,
              sliderMin: -1,
              sliderMax: 1,
            },
          ],
        },
        {
          groupTitle: 'Motion',
          params: [
            {
              key: 'motionAlgorithm',
              title: 'Motion Algorithm',
              valueType: 'enum' as const,
              defaultValue: MotionAlgorithm.Static,
              options: MOTION_ALGO_OPTIONS,
            },
            {
              key: 'motionPhaseA',
              title: 'Phase A (Tempo Sync)',
              description: 'Drive from a tempo-synced LFO',
              defaultValue: 0,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'motionPhaseB',
              title: 'Phase B (Tempo Sync)',
              description: 'Drive from a tempo-synced LFO',
              defaultValue: 0,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'motionPhaseMix',
              title: 'Phase Mix (A to B)',
              defaultValue: 0,
              sliderMin: 0,
              sliderMax: 1,
            },
            {
              key: 'motionIntensity',
              title: 'Intensity',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 2,
            },
            {
              key: 'transitionTime',
              title: 'Transition Time',
              description: 'Seconds to blend when the palette or motion algorithm changes',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 5,
            },
          ],
        },
        {
          groupTitle: 'Visual Feedback',
          params: [
            {
              key: 'showColorSpheres',
              title: 'Show Color Spheres',
              valueType: 'boolean' as const,
              defaultValue: true,
            },
          ],
        },
        {
          groupTitle: 'DMX Output',
          params: [
            {
              key: 'enableDMX',
              title: 'Enable DMX',
              valueType: 'boolean' as const,
              defaultValue: true,
            },
            {
              key: 'dmxSource',
              title: 'DMX Source',
              description:
                'Source holding the four colours as pixels 0–3; map it to lights in the DMX panel',
              valueType: 'string' as const,
              defaultValue: 'color',
            },
            {
              key: 'dmxBrightness',
              title: 'DMX Brightness',
              defaultValue: 1,
              sliderMin: 0,
              sliderMax: 2,
            },
          ],
        },
      ],
    }
  }
}

function generatePalette(
  algo: PaletteAlgorithm,
  baseHue: number,
  baseSat: number,
  baseBright: number,
  spread: number,
  contrast: number,
): Palette {
  const build = (color: (i: number) => [number, number, number]) =>
    [0, 1, 2, 3].map((i) => {
      const [hue, saturation, brightness] = color(i)
      return { hue, saturation, brightness }
    }) as Palette

  switch (algo) {
    case PaletteAlgorithm.Monochromatic:
      // Same hue, falling saturation and brightness
      return build((i) => [
        baseHue,
        Math.max(0, Math.min(1, baseSat * (1 - i * 0.2 * contrast))),
        Math.max(0.1, Math.min(1, baseBright * (1 - i * 0.15 * contrast))),
      ])

    case PaletteAlgorithm.Analogous:
      // Neighbouring hues, ±45° at a spread of 1
      return build((i) => [
        (baseHue + (i - 1.5) * HUE_STEP * spread + 1) % 1,
        baseSat,
        baseBright * (1 - i * 0.1 * contrast),
      ])

    case PaletteAlgorithm.Complementary:
      // The base and its opposite, then a softer copy of each
      return build((i) => {
        const tier = Math.floor(i / 2)
        return [
          (baseHue + (i % 2) * 0.5) % 1,
          baseSat * (1 - tier * 0.2 * contrast),
          baseBright * (1 - tier * 0.15 * contrast),
        ]
      })

    case PaletteAlgorithm.SplitComplementary: {
      // The base, the two hues either side of its opposite, and a softer base
      const split = HUE_STEP * spread
      const hues = [
        baseHue,
        (baseHue + 0.5 - split + 1) % 1,
        (baseHue + 0.5 + split + 1) % 1,
        baseHue,
      ]
      return build((i) => [
        hues[i],
        baseSat * (i === 3 ? 0.7 : 1),
        baseBright * (i === 3 ? 0.8 : 1 - i * 0.1 * contrast),
      ])
    }

    case PaletteAlgorithm.Triadic:
      // Three hues 120° apart, and a softer base
      return build((i) => [
        (baseHue + (i % 3) / 3) % 1,
        baseSat * (i === 3 ? 0.7 : 1),
        baseBright * (i === 3 ? 0.8 : 1),
      ])

    case PaletteAlgorithm.Tetradic:
      // Two complementary pairs, offset by the spread
      return build((i) => {
        const tier = Math.floor(i / 2)
        return [
          (baseHue + (i % 2) * 0.5 + tier * HUE_STEP * spread) % 1,
          baseSat * (1 - tier * 0.15 * contrast),
          baseBright,
        ]
      })

    case PaletteAlgorithm.Square:
      // Four hues 90° apart
      return build((i) => [
        (baseHue + i * 0.25) % 1,
        baseSat,
        baseBright * (1 - i * 0.1 * contrast),
      ])

    case PaletteAlgorithm.Compound:
    default: {
      // The base, its opposite, and a neighbour either side of the base
      const hues = [
        baseHue,
        (baseHue + 0.5) % 1,
        (baseHue + HUE_STEP * spread) % 1,
        (baseHue - HUE_STEP * spread + 1) % 1,
      ]
      return build((i) => [
        hues[i],
        baseSat * (i === 1 ? 0.9 : 1),
        baseBright * (1 - i * 0.08 * contrast),
      ])
    }
  }
}

/** Animates a palette from phase `t`; `intensity` scales how far one phase cycle moves it. */
function applyMotion(
  colors: Palette,
  motion: MotionAlgorithm,
  t: number,
  intensity: number,
): Palette {
  return colors.map((color, i) => {
    let { hue, saturation, brightness } = color

    switch (motion) {
      case MotionAlgorithm.Rotating: {
        // Slide the palette through the four slots, blending between neighbours.
        // At intensity 1, one phase cycle moves every colour through all four.
        const pos = (((i - t * intensity * 4) % 4) + 4) % 4
        const slot = Math.floor(pos)
        ;({ hue, saturation, brightness } = interpolateColor(
          colors[slot],
          colors[(slot + 1) % 4],
          pos - slot,
        ))
        break
      }

      case MotionAlgorithm.Breathing: {
        // All colours rise and fall together
        const breathe = Math.sin(t * intensity * Math.PI * 2) * 0.5 + 0.5
        brightness *= 0.5 + breathe * 0.5
        break
      }

      case MotionAlgorithm.Pulsing: {
        // Each colour pulses a quarter cycle after the last
        const pulse = Math.sin((t + i * 0.25) * intensity * Math.PI * 2) * 0.5 + 0.5
        brightness *= 0.5 + pulse * 0.5
        break
      }

      case MotionAlgorithm.Wave: {
        // A shallower ripple of brightness moving through the colours
        const wave = Math.sin((t + i * 0.25) * intensity * Math.PI * 2)
        brightness *= 0.7 + wave * 0.3
        break
      }
    }

    return {
      hue: ((hue % 1) + 1) % 1,
      saturation: Math.max(0, Math.min(1, saturation)),
      brightness: Math.max(0.05, Math.min(1, brightness)),
    }
  }) as Palette
}

/**
 * Folds the palette into two pairs: toward [0, 1, 0, 1] as `condense` goes to -1, toward
 * [2, 3, 2, 3] as it goes to 1, and unchanged at 0.
 */
function applyCondense(colors: Palette, condense: number): Palette {
  if (!condense) return colors
  const pair = condense < 0 ? 0 : 2
  const amount = Math.abs(condense)
  return colors.map((color, i) =>
    interpolateColor(color, colors[pair + (i % 2)], amount),
  ) as Palette
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Blends two colours, taking the short way round the hue wheel. */
function interpolateColor(c1: Hsv, c2: Hsv, t: number): Hsv {
  let hueDiff = c2.hue - c1.hue
  if (hueDiff > 0.5) hueDiff -= 1
  if (hueDiff < -0.5) hueDiff += 1

  return {
    hue: (((c1.hue + hueDiff * t) % 1) + 1) % 1,
    saturation: c1.saturation + (c2.saturation - c1.saturation) * t,
    brightness: c1.brightness + (c2.brightness - c1.brightness) * t,
  }
}

/** HSV to 0–1 RGB. */
function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p]
    case 1:
      return [q, v, p]
    case 2:
      return [p, v, t]
    case 3:
      return [p, q, v]
    case 4:
      return [t, p, v]
    default:
      return [v, p, q]
  }
}
