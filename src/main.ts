// Electron main process half: owns the USB and network transports the renderer can't reach.
import fs from 'fs'
import path from 'path'
import { defineMainPlugin } from '@hedron-gl/plugin-sdk'
import type { FrameContext } from './UniverseSender'
import { LIBRARY_FILE } from './library-file'
import { dmxService } from './main/dmxService'
import { NetworkSender } from './main/network'

/** Before it was a plugin, the library lived at the root of Hedron's user data folder. */
const migrateLibrary = (dataDir: string) => {
  const target = path.join(dataDir, LIBRARY_FILE)
  // dataDir is `<userData>/plugin-data/<id>`
  const legacy = path.join(dataDir, '..', '..', 'dmx-fixture-library.json')
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return
  fs.copyFileSync(legacy, target)
  console.log(`[DMX] Moved the fixture library to ${target}`)
}

export default defineMainPlugin({
  activate: (ctx) => {
    migrateLibrary(ctx.dataDir)
    const network = new NetworkSender()

    ctx.on('writeUniverse', (frame, universe, bytes) => {
      const { protocol, lerpSpeed, target } = frame as FrameContext
      if (protocol === 'usb') {
        network.stop()
        dmxService.writeUniverse(universe as number, bytes as Uint8Array, lerpSpeed)
      } else {
        network.send(protocol, universe as number, bytes as Uint8Array, target)
      }
    })

    ctx.on('stop', () => {
      network.stop()
      dmxService.blackout()
    })

    ctx.handle('getDevices', async () => [
      ...(await dmxService.getDevices()),
      ...network.describe(),
    ])

    return () => {
      dmxService.destroy()
      network.close()
    }
  },
})
