// Types for sketches importing the DMX plugin's API; copy this file into a sketches project to use it there.
declare module '@hedron-plugins/dmx-lighting' {
  interface PixelSource {
    readonly id: string
    readonly width: number
    readonly height: number
    readonly pixelCount: number
    /** RGBWI floats per pixel, for bulk writes. */
    target: Float32Array
    set(index: number, r: number, g: number, b: number, w?: number, intensity?: number): void
  }

  // Each export is undefined while the plugin isn't loaded
  export const source: ((id: string, width?: number, height?: number) => PixelSource) | undefined
  export const sourceFromCanvas:
    | ((
        id: string,
        canvas: HTMLCanvasElement,
        options?: { width?: number; height?: number },
      ) => PixelSource)
    | undefined
  export const setColor:
    | ((id: string, r: number, g: number, b: number, w?: number, intensity?: number) => void)
    | undefined
}
