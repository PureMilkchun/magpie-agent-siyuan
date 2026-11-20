import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { syncSiyuan } from "./bridge.mjs"

let started = false

export default function SiYuan({ directory }) {
  if (started) return {}
  started = true

  let lastMessage = ""
  let ownsGateway = false
  async function tick() {
    try {
      if (!ownsGateway) {
        // One-off CLI commands may also load the shared plugin host.
        const gateway = await readFile(join(directory, "gateway.json"), "utf8")
          .then(JSON.parse).catch(() => null)
        ownsGateway = gateway?.pid === process.ppid
        if (!ownsGateway) return
      }
      const result = await syncSiyuan()
      if (result !== lastMessage) {
        if (result === "connected") console.info("[siyuan] 已同步智能体模型")
        if (result === "restored") console.info("[siyuan] 已撤销智能体的 Magpie 配置")
        lastMessage = result
      }
    } catch (error) {
      if (error.message !== lastMessage) {
        console.warn("[siyuan]", error.message)
        lastMessage = error.message
      }
    } finally {
      setTimeout(tick, 1500).unref()
    }
  }

  void tick()
  // Magpie restores the agent control file before disabling/removing the
  // plugin. Its host can then exit before the next tick.
  process.once("exit", () => {
    if (!ownsGateway) return
    spawnSync(process.execPath, [fileURLToPath(new URL("./bridge.mjs", import.meta.url)), "restore"], {
      timeout: 1450,
      stdio: "ignore",
      windowsHide: true,
    })
  })
  return {}
}
