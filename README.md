# DMX Lighting for Hedron

A [Hedron](https://github.com/nudibranchrecords/hedron/) plugin that drives DMX lighting over USB (ENTTEC Open DMX / FT232R), ArtNet and sACN.
Sketches write colours into named sources; the panel decides which lights exist, where they are
patched and which colours reach which of their heads.

## Install

```bash
git clone <this repo>
cd hedron-dmx
pnpm install
```

Then in Hedron, open the **Plugins** panel, choose **Add plugin folder** and pick this folder.
Hedron bundles the plugin itself and reloads it when files change, so there's no build step.

`pnpm install` is only needed for USB output (the native `usb` module). ArtNet and sACN work
without it.

On Windows, USB output needs the FT232R's driver swapped to WinUSB with [Zadig](https://zadig.akeo.ie/).

## Features

- A fixture library shared by every project, with explicit channel tables per mode
- A rig of fixtures at any address, sharing channels where the hardware does
- Mappings that spread a source across heads or reduce a range to one colour
- A channel map with per-channel descriptions on hover and overrides on click
- Identify, duplicate-to-next-address and a top-down stage view
- ArtNet broadcast or unicast and sACN multicast or unicast, set by **Network Target IP**

Nothing is transmitted until the rig has a fixture, an override or a test mode on, so loading the
plugin never sends onto a network by surprise.

## Sketch API

```ts
import { source, setColor } from '@hedron-plugins/dmx-lighting'

const strip = source?.('strip', 28)
strip?.set(0, 255, 128, 0)

setColor?.('house', 255, 128, 0)
```

Every export is `undefined` while the plugin isn't loaded, hence the `?.`. For types, copy
`types/sketch-api.d.ts` into your sketches project. The older `window.hedron.lighting` global still
works. Other plugins import it the same way, with `"dmx-lighting"` in their `hedron.dependencies`.
Sources keep working across a hot reload of this plugin, since the new instance adopts them.

See `DMX.md` for the full model. Working sketches live in `example/sketches`:

| Sketch          | Writes                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `fixture-color` | One colour with `setColor`, and tints the scene to match                   |
| `color-control` | A four-colour palette from colour-theory rules, as a four-pixel source     |
| `bar-vu`        | Three overlaid VU meters across a pixel strip; bind each to an audio band  |
| `bar-spectrum`  | The audio plugin's full spectrum across a pixel strip, coloured by level   |
| `bar-chase`     | Three chase heads with fading trails, each placed by an LFO or audio value |

The bar sketches share `example/shared/BarStrip.ts`, which handles the source, an on-screen
preview, and master hue shift and brightness.

## Layout

| Path                       | Runs in                                                  |
| -------------------------- | -------------------------------------------------------- |
| `src/index.ts`             | Hedron's renderer: plugin, panel, compositor             |
| `src/main.ts`, `src/main/` | Electron's main process: USB, ArtNet and sACN transports |
| `scripts/verify-rig.mjs`   | Node, via `pnpm verify`: headless compositor checks      |

## Development

```bash
pnpm typecheck
pnpm verify
```

The `@hedron-gl/*` dev dependencies link to a Hedron checkout beside this repo
(`../hedron`) and are used for types only. At runtime the plugin uses Hedron's own copies.
