import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import config from '../config.js'
import { recommendSites, planSearch, generatePlan, validateRows, testApiConnection } from './ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============ AI 接口设置（界面上填的地址/密钥，存在用户数据目录，不随安装包走） ============
const settingsFile = path.join(app.getPath('userData'), 'crawler-settings.json')

function readSettings () {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch (_) {
    return {}
  }
}

// 启动时把界面里保存过的设置覆盖到 config 上，ai.js 就直接用它了
function applySettings () {
  const saved = readSettings()
  if (saved.apiBaseUrl) config.DEEPSEEK_BASE_URL = String(saved.apiBaseUrl).trim()
  if (saved.apiKey) config.DEEPSEEK_API_KEY = String(saved.apiKey).trim()
  if (saved.model) config.DEEPSEEK_MODEL = String(saved.model).trim()
}
applySettings()

// 打包后浏览器内核随应用一起分发（见 package.json 的 extraResources），
// 必须在 playwright-core 被加载之前把路径指过去，所以 crawler / analyze 用动态 import。
const bundledBrowsers = process.resourcesPath ? path.join(process.resourcesPath, 'ms-playwright') : ''
if (bundledBrowsers && fs.existsSync(bundledBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers
}

let crawlerModule = null
async function loadCrawler () {
  if (!crawlerModule) crawlerModule = await import('./crawler.js')
  return crawlerModule
}

let analyzeModule = null
async function loadAnalyzer () {
  if (!analyzeModule) analyzeModule = await import('./analyze.js')
  return analyzeModule
}

// 上一次站点调研采到的页面结构摘要，规划阶段要用
let lastAnalysis = null
// 上一次调研确定下来的"主题核心词"，抓取和校验阶段用来过滤无关数据
let lastTopicKeywords = []

let win = null

function createWindow () {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: '本地爬虫工作台',
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ============ 统一返回结构，避免 IPC 抛错导致渲染进程崩溃 ============
function ok (data) {
  return { ok: true, data }
}
function fail (error) {
  return { ok: false, error: error?.message || String(error) }
}

/**
 * AI 不可用时的兜底：从主题里去掉通用词，剩下的当核心词
 */
function fallbackTopicKeywords (topic) {
  const stop = /(项目|公告|公示|招标|投标|采购|询价|信息|结果|通知|消息|最新|查询|检索|平台|网站|数据|文件|公示)/g
  const core = String(topic || '')
    .replace(stop, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return core.length >= 2 ? [core] : []
}

// ============ AI：搜索规划（把主题扩展成多关键词 + 搜索计划） ============
ipcMain.handle('ai:searchPlan', async (_event, payload) => {
  try {
    const result = await planSearch({
      topic: String(payload?.topic || '').trim(),
      rules: String(payload?.rules || ''),
      fields: Array.isArray(payload?.fields) ? payload.fields : [],
      fieldDefs: Array.isArray(payload?.fieldDefs) ? payload.fieldDefs : [],
      dateRange: payload?.dateRange || null
    })
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})

// ============ 站点调研：AI 推荐 + 搜索引擎发现 + 页面结构摘要 ============
ipcMain.handle('site:analyze', async (_event, payload) => {
  const push = (data) => {
    if (win && !win.isDestroyed()) win.webContents.send('crawl:progress', data)
  }

  try {
    const topic = String(payload?.topic || '').trim()
    const rules = String(payload?.rules || '')
    const links = Array.isArray(payload?.links) ? payload.links.filter(Boolean) : []
    const expand = payload?.expand !== false
    // 搜索规划里勾选的扩展关键词：调研阶段先用它去试站内检索
    const searchKeywords = Array.isArray(payload?.searchKeywords)
      ? payload.searchKeywords.map((k) => String(k || '').trim()).filter(Boolean)
      : []

    // 1) 让 AI 推荐站点、检索关键词、以及判断相关性的核心词；这一步失败不影响后面的流程
    let aiSites = []
    let keywords = []
    let topicKeywords = []
    if (expand && topic) {
      push({ phase: 'analyze', percent: 2, message: 'AI 正在推荐可能有相关内容的网站…' })
      try {
        const recommend = await recommendSites({ topic, rules, links })
        aiSites = recommend.sites
        keywords = recommend.keywords
        topicKeywords = recommend.topicKeywords
        push({
          phase: 'analyze',
          percent: 4,
          message: `AI 推荐了 ${aiSites.length} 个站点，检索词：${keywords.join('、') || '无'}`
        })
      } catch (err) {
        push({ phase: 'analyze', percent: 4, message: `AI 站点推荐失败（继续用已有链接）：${err.message}` })
      }
    }

    // 核心词决定"哪些记录算和主题相关"，AI 没给出就用本地兜底
    if (!topicKeywords.length) topicKeywords = fallbackTopicKeywords(topic)
    lastTopicKeywords = topicKeywords
    if (topicKeywords.length) {
      push({ phase: 'analyze', percent: 4, message: `主题核心词（用于过滤无关数据）：${topicKeywords.join('、')}` })
    }

    const candidates = [
      ...links.map((url) => ({ url, source: '用户推荐' })),
      ...(expand ? aiSites.map((s) => ({ url: s.url, source: 'AI推荐', title: s.name })) : [])
    ]

    if (!candidates.length) {
      lastAnalysis = null
      return ok({ sites: [], errors: [], aiSites, keywords, topicKeywords, empty: true })
    }

    // 2) 逐个打开页面采集真实结构（含站内检索）
    const { analyzeSites } = await loadAnalyzer()
    const analysis = await analyzeSites({
      candidates,
      // 优先用搜索规划扩展出来的关键词去试站内检索，没有才退回 AI 推荐的关键词
      keywords: searchKeywords.length ? searchKeywords : expand ? keywords : [],
      topic,
      topicKeywords,
      expand,
      onProgress: push
    })
    lastAnalysis = analysis.sites.length ? analysis : null

    return ok({
      aiSites,
      keywords,
      searchKeywords,
      topicKeywords,
      searchKeyword: topic,
      errors: analysis.errors,
      sites: analysis.sites.map((s) => ({
        // 搜索发现拿到的是搜索引擎的跳转地址，展示时用落地页
        url: s.finalUrl || s.url,
        source: s.source,
        title: s.title,
        listPages: (s.listPages || []).map((p) => ({
          url: p.url,
          kind: p.kind || '',
          title: p.title,
          bestSelector: p.lists?.[0]?.selector || '',
          bestCount: p.lists?.[0]?.count || 0
        })),
        canBatchSearch: !!s.searchTemplate,
        sampleDetailUrl: s.sampleDetail?.url || ''
      }))
    })
  } catch (err) {
    return fail(err)
  }
})

// ============ AI：规划阶段（使用上一步采到的页面结构） ============
ipcMain.handle('ai:plan', async (_event, payload) => {
  try {
    const plan = await generatePlan({
      ...(payload || {}),
      sites: lastAnalysis?.sites || []
    })
    return ok(plan)
  } catch (err) {
    return fail(err)
  }
})

// ============ AI：校验阶段 ============
ipcMain.handle('ai:validate', async (_event, payload) => {
  try {
    const result = await validateRows({
      ...(payload || {}),
      // 让 AI 知道主题是什么，才能把"和主题无关"的记录删掉
      topicKeywords: lastTopicKeywords
    })
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})

// ============ 爬虫执行 ============
ipcMain.handle('crawl:start', async (_event, payload) => {
  try {
    const { runCrawl } = await loadCrawler()
    const result = await runCrawl({
      plan: payload?.plan,
      passwordBook: payload?.passwordBook,
      fields: payload?.fields,
      // 抓完之后按主题核心词 + 时间要求过滤（用户指定的时间段优先于规则里的时间描述）
      topicKeywords: lastTopicKeywords,
      rules: payload?.rules,
      dateRange: payload?.dateRange,
      onProgress: (data) => {
        if (win && !win.isDestroyed()) win.webContents.send('crawl:progress', data)
      }
    })
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})

ipcMain.handle('crawl:stop', async () => {
  try {
    const { requestStop } = await loadCrawler()
    requestStop()
    return ok(true)
  } catch (err) {
    return fail(err)
  }
})

// ============ Excel 保存（内容由渲染进程的 SheetJS 生成） ============
ipcMain.handle('excel:save', async (_event, payload) => {
  try {
    const data = payload?.data
    if (!data) throw new Error('没有可保存的 Excel 内容')

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: payload?.title || '保存爬取结果',
      defaultPath: payload?.fileName || `crawl-result-${Date.now()}.xlsx`,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return ok({ saved: false })

    await fsp.writeFile(filePath, Buffer.from(data))
    return ok({ saved: true, filePath })
  } catch (err) {
    return fail(err)
  }
})

ipcMain.handle('shell:showItem', async (_event, filePath) => {
  try {
    if (filePath) shell.showItemInFolder(filePath)
    return ok(true)
  } catch (err) {
    return fail(err)
  }
})

// ============ 打开 Excel（导入配置：读回二进制交给渲染进程的 SheetJS 解析） ============
ipcMain.handle('file:openExcel', async (_event, payload) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: payload?.title || '选择文件',
      properties: ['openFile'],
      filters: [{ name: '表格文件', extensions: ['xlsx', 'xls', 'csv'] }]
    })
    if (canceled || !filePaths?.length) return ok({ canceled: true })

    const data = await fsp.readFile(filePaths[0])
    return ok({ canceled: false, filePath: filePaths[0], data })
  } catch (err) {
    return fail(err)
  }
})

// ============ 配置状态 ============
ipcMain.handle('config:get', () => {
  const key = String(config.DEEPSEEK_API_KEY || '')
  const saved = readSettings()
  return ok({
    hasApiKey: !!key && !key.includes('REPLACE_ME') && !key.includes('请填写'),
    model: config.DEEPSEEK_MODEL,
    apiBaseUrl: config.DEEPSEEK_BASE_URL,
    // 密钥只回一个掩码，明文不回渲染进程
    apiKeyMask: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '',
    fromFile: !!saved.apiKey,
    headless: config.HEADLESS === true,
    maxPages: config.MAX_PAGES,
    requestTimeout: config.REQUEST_TIMEOUT
  })
})

// 测试连通性：用界面上填的（没填就用当前生效的）配置发一次最小请求
ipcMain.handle('settings:test', async (_event, payload) => {
  try {
    const result = await testApiConnection({
      baseUrl: payload?.apiBaseUrl,
      apiKey: payload?.apiKey,
      model: payload?.model
    })
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})

// 保存设置：写入用户数据目录，并立刻生效（下次启动也会自动读取）
ipcMain.handle('settings:save', async (_event, payload) => {
  try {
    const typed = String(payload?.apiKey || '').trim()
    // 密钥留空表示"沿用已保存的"，只有从来没有配过才报错
    const apiKey = typed || String(config.DEEPSEEK_API_KEY || '').trim()
    const apiBaseUrl = String(payload?.apiBaseUrl || '').trim().replace(/\/+$/, '')
    const model = String(payload?.model || '').trim()
    if (!apiKey) throw new Error('API 密钥不能为空')

    const data = {
      apiBaseUrl: apiBaseUrl || config.DEEPSEEK_BASE_URL,
      apiKey,
      model: model || config.DEEPSEEK_MODEL,
      savedAt: new Date().toISOString()
    }
    await fsp.writeFile(settingsFile, JSON.stringify(data, null, 2), 'utf8')

    config.DEEPSEEK_BASE_URL = data.apiBaseUrl
    config.DEEPSEEK_API_KEY = data.apiKey
    config.DEEPSEEK_MODEL = data.model

    return ok({ saved: true, filePath: settingsFile, model: data.model })
  } catch (err) {
    return fail(err)
  }
})
