import { definePlugin } from '@hedron-gl/plugin-sdk'
import { DmxLightingPlugin } from './DmxLightingPlugin'
import { DmxLightingGlobalPanel } from './DmxLightingGlobalPanel'

export type { LightingApi } from './DmxLightingPlugin'

export default definePlugin({
  create: (ctx) => {
    const plugin = new DmxLightingPlugin(ctx)

    // Sketches written before `@hedron-plugins/dmx-lighting` existed read this global
    const lighting = plugin.lightingApi()
    window.hedron = { ...window.hedron, lighting }
    const dispose = plugin.dispose.bind(plugin)
    plugin.dispose = () => {
      const handoff = dispose()
      if (window.hedron?.lighting === lighting) delete window.hedron.lighting
      return handoff
    }

    return plugin
  },
  views: {
    globalPanel: DmxLightingGlobalPanel,
  },
  api: (plugin) => ({ ...plugin.lightingApi() }),
})
