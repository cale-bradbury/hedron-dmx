import { Uniform, ShaderMaterial, Vector3 } from 'three'
import { Pass, ShaderPass } from 'postprocessing'
import { setColor } from '@hedron-plugins/dmx-lighting'

const fragmentShader = `
  uniform vec3 u_color;
  uniform float u_brightness;
  varying vec2 vUv;
  uniform sampler2D u_texture;
  void main() {
    vec4 base = texture2D(u_texture, vUv);
    vec3 tint = base.rgb * u_color;
    tint = mix(base.rgb, tint, u_brightness);
    gl_FragColor = vec4(tint, base.a);
  }
`

export default class FixtureColorSketch {
  shader?: ShaderMaterial
  passes?: Pass[]
  private colorA = new Vector3()
  private colorB = new Vector3()

  getPasses(): Pass[] {
    if (!this.passes) {
      this.shader = this.createTintShader()
      this.passes = [new ShaderPass(this.shader, 'u_texture')]
    }
    return this.passes
  }

  createTintShader(): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: {
        u_color: new Uniform(new Vector3(1, 1, 1)),
        u_brightness: new Uniform(1),
        u_texture: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader,
    })
  }

  update({ params }) {
    const mixed = this.colorA
      .fromArray(params.colorA)
      .lerp(this.colorB.fromArray(params.colorB), params.mix)
    if (this.shader) {
      this.shader.uniforms.u_color.value.copy(mixed)
      this.shader.uniforms.u_brightness.value = params.brightness
    }

    // A one-pixel source; mappings in the DMX panel decide which lights show it.
    // setColor is undefined while the DMX plugin isn't loaded.
    if (setColor) {
      const byte = (v: number) =>
        Math.max(0, Math.min(255, Math.round(v * 255 * params.brightness)))
      setColor(
        params.sourceName || 'fixture-1',
        byte(mixed.x),
        byte(mixed.y),
        byte(mixed.z),
        byte(params.white),
        byte(params.intensity),
      )
    }
  }

  static getConfig() {
    return {
      title: 'Fixture Color',
      description: 'Mixes two colors and sends to DMX, also tints the scene.',
      category: 'lighting',
      params: [
        {
          title: 'Source Name',
          key: 'sourceName',
          valueType: 'string',
          defaultValue: 'fixture-1',
        },
        {
          title: 'Color A',
          key: 'colorA',
          valueType: 'rgb',
          defaultValue: [1, 0, 0],
        },
        {
          title: 'Color B',
          key: 'colorB',
          valueType: 'rgb',
          defaultValue: [0, 0, 1],
        },
        {
          title: 'Mix',
          key: 'mix',
          valueType: 'number',
          defaultValue: 0.5,
          sliderMin: 0,
          sliderMax: 1,
        },
        {
          title: 'Brightness',
          key: 'brightness',
          valueType: 'number',
          defaultValue: 1,
          sliderMin: 0,
          sliderMax: 1,
        },
        {
          title: 'White',
          key: 'white',
          valueType: 'number',
          defaultValue: 0,
          sliderMin: 0,
          sliderMax: 1,
        },
        {
          title: 'Intensity',
          key: 'intensity',
          valueType: 'number',
          defaultValue: 1,
          sliderMin: 0,
          sliderMax: 1,
        },
      ],
    }
  }
}
