import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { syncSiyuan } from "../bridge.mjs"
import { agent, connect } from "../siyuan.agent.js"

test("Magpie writes a chat-compatible gateway connection for a routing group", () => {
  const gateway = { v1: "http://127.0.0.1:3425/v1", key: "agent-fixture-key" }
  const model = { id: "group/default", name: "Default", context: 64_000 }
  assert.equal(agent.model, "model")
  assert.deepEqual(connect({ gateway, model }), {
    "gateway.url": gateway.v1,
    "gateway.key": gateway.key,
    displayName: "Default",
    contextLength: 64_000,
  })
})

test("both Magpie surfaces reference the bundled SiYuan icon", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)))
  const asset = await readFile(new URL("../assets/siyuan.svg", import.meta.url), "utf8")
  const svg = asset.slice(asset.indexOf("<svg")).replace(/\r\n/g, "\n").trim()
  assert.equal(pkg.magpie.icon, agent.icon)
  assert.equal(agent.icon, "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"))
})

test("retries an interrupted disconnect against the original workspace", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "magpie siyuan "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, ".config", "siyuan")
  const workspace = await realpath(root)
  const dir = join(home, "magpie")
  const connection = join(dir, "connection.json")
  const state = join(dir, "state.json")
  const ports = join(home, "port.json")
  const registry = join(home, "workspace.json")
  const write = (path, value) => writeFile(path, JSON.stringify(value))

  await mkdir(dir, { recursive: true })
  await mkdir(join(workspace, "conf"))
  await write(join(workspace, "conf", "conf.json"), { api: { token: "fixture-token" } })
  await write(registry, [workspace])

  const original = { id: "local", apiKey: "original-fixture", models: [{ id: "local-model" }] }
  const ai = {
    providers: [original],
    agent: { modelId: "local-model", temperature: 0.6 },
    editing: { modelId: "local-model" },
  }
  let revision = 0
  let patches = 0
  let snippetRevision = 0
  let snippetRefreshes = 0
  const userSnippet = { id: "user", type: "css", content: "body {}", enabled: false }
  let snippets = [userSnippet]
  const server = createServer(async (request, response) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)))
    const reply = (code, data) => response.end(JSON.stringify({ code, data }))
    if (request.url === "/api/system/getWorkspaceInfo") {
      assert.equal(request.headers.authorization, undefined)
      return reply(0, { workspaceDir: workspace, siyuanVer: "3.8.11" })
    }
    assert.equal(request.headers.authorization, "Token fixture-token")
    if (request.url === "/api/setting/getSection") {
      if (body.namespace === "snippet") {
        return reply(0, { conf: { snippet: { enabledCSS: false, enabledJS: false } } })
      }
      assert.deepEqual(body, { namespace: "ai" })
      return reply(0, { conf: { ai }, revision })
    }
    if (request.url === "/api/snippet/getSnippet") {
      return reply(0, { snippets, revision: String(snippetRevision) })
    }
    if (request.url === "/api/snippet/setSnippet") {
      assert.equal(body.revision, String(snippetRevision))
      snippets = body.snippets
      snippetRevision++
      return reply(0, null)
    }
    assert.equal(request.url, "/api/setting/patch")
    if (body.snippet) {
      assert.deepEqual(body, { snippet: { enabledCSS: false } })
      snippetRefreshes++
      return reply(0, null)
    }
    const patch = body.ai
    if (patch.providers) ai.providers = patch.providers
    Object.assign(ai.agent, patch.agent)
    patches++
    revision++
    return reply(0, null)
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const running = { [process.pid]: server.address().port }
  await write(ports, running)

  await write(connection, {
    model: "group/default",
    gateway: { url: "http://127.0.0.1:3425/v1", key: "agent-fixture-key" },
    contextLength: 64_000,
  })
  assert.equal(await syncSiyuan(home), "connected")
  const added = ai.providers[1]
  assert.equal(added.protocol, "openai")
  assert.equal(added.models[0].name, "group/default")
  assert.equal(ai.agent.modelId, added.models[0].id)
  assert.equal(ai.editing.modelId, "local-model")
  assert.doesNotMatch(await readFile(state, "utf8"), /agent-fixture-key|original-fixture|fixture-token/)
  const logo = snippets[1]
  assert.equal(logo.id, added.id)
  assert.equal(logo.type, "css")
  assert.equal(logo.disabledInPublish, true)
  assert(logo.content.includes(`#aiProviderCards [data-provider-id="${added.id}"]`))
  const asset = await readFile(new URL("../assets/magpie.svg", import.meta.url))
  assert(logo.content.includes("data:image/svg+xml;base64," + asset.toString("base64")))
  assert.equal(snippetRefreshes, 1)
  assert.equal(await syncSiyuan(home), "connected")
  assert.equal(await syncSiyuan(home, { restoreOnly: true }), "still-connected")
  assert.equal(patches, 1)

  // An existing 0.1 connection gets its logo without retaking the model.
  const oldState = JSON.parse(await readFile(state, "utf8"))
  delete oldState.logoVersion
  await write(state, oldState)
  snippets = [userSnippet]
  ai.agent.modelId = "local-model"
  assert.equal(await syncSiyuan(home), "connected")
  assert.equal(ai.agent.modelId, "local-model")
  assert.equal(patches, 1)
  assert.deepEqual(snippets, [userSnippet, logo])
  ai.agent.modelId = added.models[0].id

  await rm(connection)
  await write(ports, {})
  await write(registry, [workspace, join(home, "other-workspace")])
  await assert.rejects(syncSiyuan(home), /等待目标思源工作区/)
  assert.equal(ai.agent.modelId, added.models[0].id)

  ai.agent.temperature = 0.8
  const another = { id: "another", models: [{ id: "another-model" }] }
  ai.providers.push(another)

  // Restore with the standalone CLI, a custom kernel home and a PowerShell
  // UTF-8 BOM. Loopback must work even when an environment proxy is unusable.
  const customHome = join(root, "思源用户目录")
  const customRegistry = join(customHome, ".config", "siyuan")
  await mkdir(customRegistry, { recursive: true })
  await writeFile(join(customRegistry, "port.json"), "\uFEFF" + JSON.stringify(running))
  const bridge = fileURLToPath(new URL("../bridge.mjs", import.meta.url))
  const restore = spawn(process.execPath, [bridge, "restore"], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SIYUAN_HOME_DIR: customHome,
      HTTP_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
      NODE_USE_ENV_PROXY: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
    signal: AbortSignal.timeout(10_000),
    windowsHide: true,
  })
  assert.deepEqual(await once(restore, "exit"), [0, null])
  assert.deepEqual(ai.providers, [original, another])
  assert.deepEqual(ai.agent, { modelId: "local-model", temperature: 0.8 })
  assert.deepEqual(snippets, [userSnippet])
  assert.equal(snippetRefreshes, 3)
  assert.equal(await syncSiyuan(home), "idle")
})
