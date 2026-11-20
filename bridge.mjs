import { createHash, randomUUID } from "node:crypto"
import { readFile, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

export const siyuanHome = join(homedir(), ".config", "siyuan")
const nodeID = /^\d{14}-[a-z0-9]{7}$/
const logoVersion = 1
const logoSnippetName = "Magpie 提供商图标"

function newID() {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/\D/g, "")
  return timestamp + "-" + randomUUID().slice(0, 7)
}

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    // JSON parser messages can contain snippets of keys and tokens.
    throw new Error(`无法读取 ${file}（${error.code || "JSON 格式错误"}）`)
  }
}

async function readConnection(file) {
  const config = await readJSON(file)
  if (!config || Object.keys(config).length === 0) return null
  const { model, gateway, displayName, contextLength } = config
  if (!model && !gateway?.key && !gateway?.url) return null

  const url = URL.parse(gateway?.url ?? "")
  if (typeof model !== "string" || !model.includes("/") || /\s/u.test(model) ||
      typeof gateway?.key !== "string" || !/^[!-~]+$/.test(gateway.key) ||
      !url || !["http:", "https:"].includes(url.protocol) ||
      !url.pathname.endsWith("/v1") || url.username || url.password || url.search || url.hash) {
    throw new Error("Magpie 连接信息不完整，请在 Agents 页面重新选择模型")
  }
  return {
    model,
    url: url.href,
    key: gateway.key,
    displayName: typeof displayName === "string" && displayName.trim() || model,
    contextLength: Number.isInteger(contextLength) && contextLength > 0 && contextLength <= 100_000_000
      ? contextLength : 0,
  }
}

async function request(port, endpoint, body = {}, token = "") {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(1800),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`思源接口 ${endpoint} 返回 HTTP ${response.status}`)
  const result = await response.json().catch(() => null)
  if (result?.code !== 0) {
    throw new Error(`思源接口 ${endpoint} 拒绝了请求，请检查 API Token 和工作区的读写状态`)
  }
  return result.data
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

async function locateKernel(home, pinnedWorkspace) {
  const workspaces = pinnedWorkspace ? null : await readJSON(join(home, "workspace.json"))
  const selected = pinnedWorkspace ?? (Array.isArray(workspaces) ? workspaces.at(-1) : null)
  if (typeof selected !== "string" || !isAbsolute(selected)) {
    throw new Error("请先在本机打开一个思源桌面工作区")
  }
  const workspace = await realpath(selected).catch(() => normalize(selected))
  const ports = await readJSON(join(home, "port.json"))
  const candidates = Object.entries(ports ?? {})
    .map(([pid, port]) => [Number(pid), Number(port)])
    .filter(([pid, port]) => Number.isSafeInteger(pid) && pid > 0 &&
      Number.isInteger(port) && port > 0 && port <= 65535 && processExists(pid))

  // The workspace identity endpoint is available on loopback before auth.
  // Identify the matching kernel before sending its workspace's token.
  const matches = await Promise.all(candidates.map(async ([, port]) => {
    try {
      const info = await request(port, "/api/system/getWorkspaceInfo")
      return typeof info.siyuanVer === "string" && await realpath(info.workspaceDir) === workspace
        ? port : null
    } catch {
      return null
    }
  }))
  const port = matches.find(Boolean)
  if (!port) throw new Error("正在等待目标思源工作区启动")
  const conf = await readJSON(join(workspace, "conf", "conf.json"))
  const token = conf?.api?.token
  if (!conf || typeof token !== "string") throw new Error("无法读取思源工作区的 API Token")
  return { workspace, call: (endpoint, body) => request(port, endpoint, body, token) }
}

function providerFor(connection, state) {
  const model = {
    id: state.modelId,
    name: connection.model,
    displayName: connection.displayName,
    enabled: true,
  }
  if (connection.contextLength) model.contextLength = connection.contextLength
  return {
    id: state.providerId,
    displayName: "Magpie",
    protocol: "openai",
    enabled: true,
    apiKey: connection.key,
    baseURL: connection.url,
    requestTimeout: 120,
    models: [model],
  }
}

async function saveState(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

function fingerprint(connection) {
  return connection && createHash("sha256").update(JSON.stringify(connection)).digest("hex")
}

async function readAI(kernel) {
  const data = await kernel.call("/api/setting/getSection", { namespace: "ai" })
  const ai = data?.conf?.ai
  if (!Array.isArray(ai?.providers) || typeof ai.agent?.modelId !== "string") {
    throw new Error("思源 AI 设置不可读，请检查版本和 API Token")
  }
  return { ai, revision: data.revision }
}

async function syncProviderLogo(kernel, providerId, connected) {
  const { snippets, revision } = await kernel.call("/api/snippet/getSnippet", { type: "all", enabled: 2 })
  if (!Array.isArray(snippets) || !revision) throw new Error("无法读取思源 CSS 片段版本")
  const existing = snippets.find(snippet => snippet.id === providerId)
  if (existing && (existing.name !== logoSnippetName || existing.type !== "css")) {
    if (connected) throw new Error("Magpie 图标的 CSS 片段 ID 已被占用")
    return
  }
  if (!connected && !existing) return

  let next = snippets.filter(snippet => snippet.id !== providerId)
  if (connected) {
    const svg = await readFile(new URL("./assets/magpie.svg", import.meta.url))
    const icon = `data:image/svg+xml;base64,${svg.toString("base64")}`
    const avatar = `#aiProviderCards [data-provider-id="${providerId}"] > .b3-card__img > span`
    const content = `${avatar} { font-size: 0; }
${avatar}::before {
  content: "";
  width: 48px;
  height: 48px;
  background-color: var(--b3-theme-on-background);
  mask: url("${icon}") center / contain no-repeat;
}`
    const snippet = { id: providerId, name: logoSnippetName, type: "css", content,
      enabled: existing?.enabled ?? true, disabledInPublish: true }
    next = existing ? snippets.map(item => item.id === providerId ? snippet : item) : [...snippets, snippet]
  }
  if (!isDeepStrictEqual(next, snippets)) {
    await kernel.call("/api/snippet/setSnippet", { snippets: next, revision })
  }
  // A nonempty settings patch triggers the kernel's live snippet refresh.
  // Reuse the current CSS switch and leave the JavaScript switch out.
  const settings = await kernel.call("/api/setting/getSection", { namespace: "snippet" })
  const enabledCSS = settings?.conf?.snippet?.enabledCSS
  if (typeof enabledCSS !== "boolean") throw new Error("无法读取思源 CSS 片段开关")
  await kernel.call("/api/setting/patch", { snippet: { enabledCSS } })
}

async function updateAI(kernel, { ai, revision }, state, connection, isCurrent) {
  const providers = ai.providers.filter(provider => provider?.id !== state.providerId)
  let modelId = ai.agent.modelId
  if (connection) {
    providers.push(providerFor(connection, state))
    modelId = state.modelId
  } else if (modelId === state.modelId) {
    modelId = state.previousModelId
  }
  const patch = {}
  if (!isDeepStrictEqual(providers, ai.providers)) patch.providers = providers
  if (modelId !== ai.agent.modelId) patch.agent = { modelId }
  if (!Object.keys(patch).length) return true

  // SiYuan merges the settings patch inside the kernel, but providers is
  // an array. Check its namespace revision before replacing that array.
  if (patch.providers && (await readAI(kernel)).revision !== revision) return false
  if (!await isCurrent()) return false
  await kernel.call("/api/setting/patch", { ai: patch })
  const { ai: saved } = await readAI(kernel)
  const savedProvider = saved.providers.find(provider => provider?.id === state.providerId)
  const applied = connection
    ? saved.agent.modelId === state.modelId && savedProvider?.models?.[0]?.name === connection.model
    : !savedProvider && saved.agent.modelId !== state.modelId
  if (!applied) throw new Error("思源未保存预期的模型配置，稍后会重试")
  return true
}

export async function syncSiyuan(home = siyuanHome, { restoreOnly = false } = {}) {
  const dir = join(home, "magpie")
  const connectionFile = join(dir, "connection.json")
  const stateFile = join(dir, "state.json")
  const connection = await readConnection(connectionFile)
  const signature = fingerprint(connection)
  const isCurrent = async () => signature === fingerprint(await readConnection(connectionFile))
  let state = await readJSON(stateFile)
  if (restoreOnly && connection) return "still-connected"
  if (!connection && !state) return "idle"

  if (state && (!nodeID.test(state.providerId) || !nodeID.test(state.modelId) ||
      typeof state.workspace !== "string" || !isAbsolute(state.workspace) ||
      typeof state.previousModelId !== "string")) {
    throw new Error("恢复记录无法识别，已保留该记录")
  }
  const modelApplied = connection && state?.applied === signature
  if (modelApplied && state.logoVersion === logoVersion) return "connected"
  const kernel = await locateKernel(home, state?.workspace)
  if (!modelApplied) {
    const snapshot = await readAI(kernel)
    if (!state) {
      state = {
        workspace: kernel.workspace,
        providerId: newID(),
        modelId: newID(),
        previousModelId: snapshot.ai.agent.modelId,
      }
      await mkdir(dir, { recursive: true, mode: 0o700 })
      // Persist recovery information before making the kernel change.
      await saveState(stateFile, state)
    }
    if (!await updateAI(kernel, snapshot, state, connection, isCurrent)) return "changed"
    if (connection) {
      state.applied = signature
      await saveState(stateFile, state)
    }
  }

  if (!await isCurrent()) return "changed"
  if (!connection || state.logoVersion !== logoVersion) {
    await syncProviderLogo(kernel, state.providerId, Boolean(connection))
  }
  if (connection) {
    if (state.logoVersion !== logoVersion) await saveState(stateFile, { ...state, logoVersion })
    return "connected"
  }
  await rm(stateFile, { force: true })
  return "restored"
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "restore") {
    console.error("用法：node bridge.mjs restore")
    process.exitCode = 1
  } else {
    try {
      const result = await syncSiyuan(siyuanHome, { restoreOnly: true })
      if (result === "still-connected") {
        console.error("请先在 Magpie 的 Agents 页面断开思源笔记")
        process.exitCode = 1
      } else if (result === "changed") {
        console.error("思源或 Magpie 的设置刚刚变更，请重试恢复")
        process.exitCode = 1
      } else {
        console.log(result === "restored" ? "已撤销思源中的 Magpie 配置" : "没有待恢复的思源配置")
      }
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
