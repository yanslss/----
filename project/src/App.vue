<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as XLSX from 'xlsx'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'

import RulePopup from './components/RulePopup.vue'
import PasswordPopup from './components/PasswordPopup.vue'
import LinksPopup from './components/LinksPopup.vue'
import ContentPopup from './components/ContentPopup.vue'
import SearchPlanPopup from './components/SearchPlanPopup.vue'
import SettingsPopup from './components/SettingsPopup.vue'
import ResultTable from './components/ResultTable.vue'

// 由 preload.cjs 注入；如果在普通浏览器里打开会是 undefined
const api = window.crawlerAPI
const bridgeReady = ref(!!api)

// ---------- 顶部：主题 + 爬取内容（字段） ----------
const topic = ref('')
// 字段定义：字段名 + 数据类型 + 备注，字段名同时用作 Excel 的列名
const fieldRows = ref(readFieldRows())
const fields = computed(() => fieldRows.value.map((f) => f.name).filter(Boolean))

// ---------- 中部：五个弹窗/选择器 ----------
const showRule = ref(false)
const showPassword = ref(false)
const showLink = ref(false)
const showContent = ref(false)
const showRange = ref(false)
const showSearchPlan = ref(false)
const showIntro = ref([])

// ---------- 搜索方案（多关键词批量搜索） ----------
// { keywords: [...], plan: [{keyword, searchType, dateRange, maxPages}] }
const searchPlan = ref({ keywords: [], plan: [] })
// 用户在弹窗里勾选后真正要跑的关键词；为空表示"全用"
const pickedKeywords = ref([])
const planning = ref(false)
// 方案生成时对应的主题；主题一变就要重新规划
const planTopic = ref('')
// 方案是否已生成并保存（保存后「开始爬取」才亮）
const planReady = ref(false)

// ---------- 设置 / 展板 ----------
const showSettings = ref(false)
// AI 接口是否已配置好（设置里填了密钥并通过测试才能保存）
const apiReady = ref(false)
// 展板当前面板：log=运行日志（默认）、rows=抓取结果、ai=AI 反馈
const boardTab = ref('log')

const rules = ref(localStorage.getItem('crawler.rules') || '')
const links = ref(readJSON('crawler.links', []))
const passwordSites = ref(readSites())
// 是否让 AI 推荐站点 + 搜索引擎补充候选页面（不只抓用户给的链接）
const expandSites = ref(localStorage.getItem('crawler.expand') !== '0')

// ---------- 底部：运行状态 + 结果 ----------
const running = ref(false)
const plan = ref(null)
const rows = ref([])
const issues = ref([])
const aiSummary = ref('')
const logs = ref([])
const logBox = ref(null)
const progress = reactive({ percent: 0, message: '' })

const configInfo = ref(null)

let offProgress = null

onMounted(async () => {
  if (!bridgeReady.value) return
  const cfg = unwrap(await api.getConfig())
  configInfo.value = cfg
  apiReady.value = !!cfg.hasApiKey
  if (!cfg.hasApiKey) {
    log('提示：还没配置 AI 接口，请点右下角「设置」填 API 地址和密钥，测试通过后才能规划与爬取')
  } else {
    log(`AI 接口：${cfg.apiBaseUrl} · 模型 ${cfg.model}${cfg.fromFile ? '（密钥来自设置）' : '（密钥来自 .env）'}`)
  }
  offProgress = api.onCrawlProgress((payload) => {
    if (!payload) return
    if (payload.phase === 'analyze') {
      // 站点调研阶段占整体进度的 2% ~ 15%
      setProgress(2 + Math.round((Number(payload.percent) || 0) * 0.13), payload.message)
    } else if (payload.phase === 'crawl') {
      // 抓取阶段占整体进度的 20% ~ 82%
      setProgress(20 + Math.round((Number(payload.percent) || 0) * 0.62), payload.message)
    } else if (payload.message) {
      log(payload.message)
    }
  })
})

onBeforeUnmount(() => {
  if (offProgress) offProgress()
})

watch(expandSites, (value) => localStorage.setItem('crawler.expand', value ? '1' : '0'))

// ============ 工具 ============
function readJSON (key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (_) {
    return fallback
  }
}

function unwrap (res) {
  if (!res) throw new Error('主进程没有响应')
  if (res.ok) return res.data
  throw new Error(res.error || '未知错误')
}

// IPC 只能传可结构化克隆的数据，Vue 的响应式代理会报 "An object could not be cloned."
// 所以发给主进程之前统一转成普通对象
function plain (value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

function setProgress (percent, message) {
  progress.percent = Math.max(0, Math.min(100, Math.round(percent)))
  progress.message = message || ''
}

async function log (text) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logs.value.push({ time, text: String(text) })
  if (logs.value.length > 300) logs.value.splice(0, logs.value.length - 300)
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
}

// ============ 爬取内容（字段定义）============

// 默认三个字段：日期、标题、正文
function defaultFields () {
  return [
    { name: '日期', type: '日期', note: '' },
    { name: '标题', type: '文本', note: '' },
    { name: '正文', type: '文本', note: '' }
  ]
}

function readFieldRows () {
  const raw = readJSON('crawler.fields', null)
  const rows = (Array.isArray(raw) ? raw : [])
    .map((f) => ({
      name: String(f?.name || '').trim(),
      type: String(f?.type || '文本'),
      note: String(f?.note || '').trim()
    }))
    .filter((f) => f.name)
  return rows.length ? rows : defaultFields()
}

function saveFieldRows (list) {
  // 一个字段都不留的话，后面「按标题判主题相关性」会失效，直接还原成默认三字段
  if (!list.length) {
    fieldRows.value = defaultFields()
    log('字段已清空，已还原为默认的「日期 / 标题 / 正文」')
  } else {
    fieldRows.value = list
    log(`爬取内容已保存 ${list.length} 个字段：${list.map((f) => f.name).join('、')}`)
  }
  localStorage.setItem('crawler.fields', JSON.stringify(fieldRows.value))
}

// ============ 爬取时间段 ============

// { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }；这个区间优先于规则设置里的时间要求
const dateRange = ref(readJSON('crawler.dateRange', null))
const rangeMin = new Date(2015, 0, 1)
const rangeMax = new Date(new Date().getFullYear() + 1, 11, 31)

const rangeLabel = computed(() =>
  dateRange.value?.from && dateRange.value?.to ? `${dateRange.value.from} ~ ${dateRange.value.to}` : '不限'
)

const rangeDefault = computed(() => {
  const pick = (value) => {
    const m = String(value || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/)
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const from = pick(dateRange.value?.from)
  const to = pick(dateRange.value?.to)
  return from && to ? [from, to] : undefined
})

function dayText (date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function onRangeConfirm (dates) {
  const list = Array.isArray(dates) ? dates : [dates]
  const from = list[0]
  const to = list[list.length - 1]
  if (!from || !to) return

  dateRange.value = { from: dayText(from), to: dayText(to) }
  localStorage.setItem('crawler.dateRange', JSON.stringify(dateRange.value))
  showRange.value = false
  log(`爬取时间段：${rangeLabel.value}（优先于规则设置里的时间要求）`)
}

function clearRange () {
  dateRange.value = null
  localStorage.removeItem('crawler.dateRange')
  showRange.value = false
  log('已清除爬取时间段，时间要求改由规则设置决定')
}

// ============ 爬取方案（多关键词批量搜索） ============

// 真正参与抓取的关键词：弹窗里勾选过就用勾选结果，没勾选过就用全部扩展词
const activeKeywords = computed(() => {
  const all = searchPlan.value.keywords || []
  if (!all.length) return []
  const picked = pickedKeywords.value || []
  if (!picked.length) return all
  const keep = all.filter((k) => picked.includes(k))
  return keep.length ? keep : all
})

function clearPlan (reason) {
  searchPlan.value = { keywords: [], plan: [] }
  pickedKeywords.value = []
  planTopic.value = ''
  planReady.value = false
  if (reason) log(reason)
}

// 主题改了但方案还是旧的：提醒用户，确认后清掉旧方案，让他重新规划
watch(topic, (value) => {
  if (!planReady.value || !planTopic.value) return
  if (String(value).trim() === planTopic.value) return

  const typed = String(value).trim() || planTopic.value
  showConfirmDialog({
    title: '主题已修改',
    message: `之前的爬取方案是按「${planTopic.value}」生成的，主题换成「${typed}」后方案不再适用。\n确认修改吗？确认后方案会被清除，需要重新点「爬取方案」做规划。`,
    confirmButtonText: '确认修改',
    cancelButtonText: '取消'
  })
    .then(() => {
      clearPlan('主题已修改，爬取方案已清除，请重新点「爬取方案」做规划')
    })
    .catch(() => {
      // 取消：把主题改回去，方案继续有效
      topic.value = planTopic.value
    })
})

/** 打开爬取方案弹窗（没规划过就在弹窗里点「开始规划」） */
function openPlanPopup () {
  if (running.value) return showToast('任务进行中，请先停止')
  if (!apiReady.value) {
    showSettings.value = true
    return showFailToast('请先在「设置」里配置 AI 接口并测试通过')
  }
  if (!topic.value.trim()) return showToast('请先输入爬取主题')
  showSearchPlan.value = true
}

/** 弹窗里点「开始规划」：带上配置信息请求 AI，结果回填到弹窗 */
async function runPlanning () {
  if (planning.value) return

  const current = topic.value.trim()
  if (!current) return showToast('请先输入爬取主题')
  if (!apiReady.value) return showFailToast('请先在「设置」里配置 AI 接口并测试通过')

  planning.value = true
  setProgress(1, 'AI 正在规划爬取方案…')
  log(`正在生成爬取方案（主题：${current}）…`)
  try {
    const result = unwrap(
      await api.searchPlan(
        plain({
          topic: current,
          rules: rules.value,
          fields: fields.value,
          fieldDefs: fieldRows.value,
          dateRange: dateRange.value
        })
      )
    )

    searchPlan.value = { keywords: result.keywords || [], plan: result.plan || [] }
    planTopic.value = current
    pickedKeywords.value = []
    // 规划出来了但还没保存 —— 需要用户在弹窗里确认保存后，才能开始爬取
    planReady.value = false

    if (!searchPlan.value.keywords.length) {
      log('AI 没给出可用关键词，这一轮只能按主题原句做站内检索')
      showFailToast('规划结果为空')
      return
    }
    log(`方案已生成，共 ${searchPlan.value.keywords.length} 个关键词：${searchPlan.value.keywords.join('、')}`)
    log(
      `每个关键词的翻页计划：${searchPlan.value.plan
        .map((p) => `${p.keyword}(${p.searchType === 'content' ? '正文' : '标题'}/${p.maxPages}页)`)
        .join('、')}`
    )
    showToast('规划完成，确认后点「保存」')
  } catch (err) {
    log(`规划失败：${err.message}`)
    showFailToast(`规划失败：${err.message}`)
  } finally {
    planning.value = false
    setProgress(0, '')
  }
}

/** 弹窗里点「保存」：用到的是用户改过的关键词与翻页数 */
function savePickedKeywords ({ keywords, plan }) {
  pickedKeywords.value = keywords
  searchPlan.value = { keywords: searchPlan.value.keywords, plan }
  planReady.value = true
  log(
    `爬取方案已保存：${keywords.length} 个关键词 —— ${plan
      .map((p) => `${p.keyword}(${p.maxPages}页)`)
      .join('、')}`
  )
  showSuccessToast('方案已保存，可以开始爬取了')
}

async function onSettingsSaved () {
  const cfg = unwrap(await api.getConfig())
  configInfo.value = cfg
  apiReady.value = !!cfg.hasApiKey
  log(`AI 接口已更新：${cfg.apiBaseUrl} · 模型 ${cfg.model}`)
}

// ============ 三个弹窗保存 ============
// 只负责写内存和 localStorage：导入配置时也复用这几个函数（避免两处各写一份存储逻辑）
function persistRules (text) {
  rules.value = text
  localStorage.setItem('crawler.rules', text)
}

function persistSites (list) {
  passwordSites.value = list
  localStorage.setItem('crawler.passwordBook', JSON.stringify(list))
}

function persistLinks (list) {
  links.value = list
  localStorage.setItem('crawler.links', JSON.stringify(list))
}

function saveRules (text) {
  persistRules(text)
  log(text ? `已保存规则：${text.replace(/\n/g, '；')}` : '已清空规则')
}

// 兼容旧版 { sites: [{ match, username, password }] } 的存储格式
function readSites () {
  const raw = readJSON('crawler.passwordBook', null)
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sites) ? raw.sites : [])
  return list
    .map((s) => ({
      site: String(s?.site || s?.match || ''),
      username: String(s?.username || ''),
      password: String(s?.password || '')
    }))
    .filter((s) => s.site || s.username)
}

function saveSites (list) {
  persistSites(list)
  log(list.length ? `密码本已保存 ${list.length} 个站点账号` : '密码本已清空')
}

function saveLinks (list) {
  persistLinks(list)
  log(list.length ? `已保存 ${list.length} 个起始链接` : '起始链接已清空')
}

// ============ 日志导出 / 配置导入导出（都用 Excel 表格） ============

// 表格行 → 去掉首行表头、去掉全空行
function sheetRows (wb, keywords) {
  const name = wb.SheetNames.find((n) => keywords.some((k) => String(n).includes(k)))
  if (!name) return []
  return XLSX.utils
    .sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' })
    .filter((row) => row.some((cell) => String(cell ?? '').trim()))
}

function timeStamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 生成工作簿并弹保存框写盘 */
async function saveWorkbook (wb, { title, fileName, okText }) {
  const res = unwrap(
    await api.saveExcel({
      title,
      data: new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })),
      fileName
    })
  )
  if (!res.saved) {
    log('已取消保存')
    return null
  }
  showSuccessToast(okText)
  log(`已保存：${res.filePath}`)
  await api.showInFolder(res.filePath)
  return res.filePath
}

async function exportLog () {
  try {
    if (!logs.value.length) return showToast('还没有日志可导出')

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['项目', '内容'],
        ['导出时间', new Date().toLocaleString('zh-CN', { hour12: false })],
        ['爬取主题', topic.value.trim() || '（未填）'],
        ['结果条数', rows.value.length],
        ['日志行数', logs.value.length]
      ]),
      '概览'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['序号', '时间', '日志内容'],
        ...logs.value.map((item, i) => [i + 1, item.time, item.text])
      ]),
      '运行日志'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['校验提示'], ...(issues.value.length ? issues.value.map((t) => [t]) : [['无']])]),
      '校验提示'
    )

    await saveWorkbook(wb, {
      title: '导出运行日志',
      fileName: `crawler-log-${timeStamp()}.xlsx`,
      okText: '日志已导出'
    })
  } catch (err) {
    showFailToast(`导出日志失败：${err.message}`)
  }
}

async function exportConfig () {
  try {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['项目', '值'],
        ['版本', 1],
        ['导出时间', new Date().toLocaleString('zh-CN', { hour12: false })],
        ['规则设置', rules.value],
        ['爬取时间段', dateRange.value ? `${dateRange.value.from} ~ ${dateRange.value.to}` : '不限'],
        ['自动扩展站点', expandSites.value ? '开' : '关']
      ]),
      '配置'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['字段名', '数据类型', '备注'],
        ...fieldRows.value.map((f) => [f.name, f.type, f.note])
      ]),
      '爬取字段'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['网站', '账号', '密码'],
        ...passwordSites.value.map((s) => [s.site, s.username, s.password])
      ]),
      '密码本'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['推荐链接'], ...links.value.map((l) => [l])]),
      '推荐链接'
    )

    await saveWorkbook(wb, {
      title: '导出配置',
      fileName: `crawler-config-${timeStamp()}.xlsx`,
      okText: '配置已导出'
    })
  } catch (err) {
    showFailToast(`导出配置失败：${err.message}`)
  }
}

async function importConfig () {
  try {
    const file = unwrap(await api.openExcel({ title: '导入配置' }))
    if (file.canceled) return

    let wb
    try {
      wb = XLSX.read(new Uint8Array(file.data), { type: 'array' })
    } catch (_) {
      throw new Error('这个文件打不开，请选择本工具导出的配置表格')
    }

    const used = []

    // ① 配置表：项目 / 值 两列
    for (const row of sheetRows(wb, ['配置'])) {
      const key = String(row[0] ?? '').trim()
      const value = String(row[1] ?? '').trim()
      if (/规则/.test(key)) {
        persistRules(value)
        used.push(value ? '规则设置' : '规则设置（清空）')
      } else if (/时间段/.test(key)) {
        const m = value.match(/(\d{4}\D\d{1,2}\D\d{1,2})\s*[~～至\-—]+\s*(\d{4}\D\d{1,2}\D\d{1,2})/)
        if (m) {
          const toDay = (s) => {
            const p = s.split(/\D/).filter(Boolean)
            return `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}`
          }
          dateRange.value = { from: toDay(m[1]), to: toDay(m[2]) }
          localStorage.setItem('crawler.dateRange', JSON.stringify(dateRange.value))
          used.push(`爬取时间段 ${rangeLabel.value}`)
        } else if (/不限|无|空/.test(value) || !value) {
          clearRange()
          used.push('爬取时间段（不限）')
        }
      } else if (/自动扩展/.test(key)) {
        expandSites.value = /^(开|是|启用|true|1|yes)$/i.test(value)
        used.push(`自动扩展站点 ${expandSites.value ? '开' : '关'}`)
      }
    }

    // ② 爬取字段表：字段名 / 数据类型 / 备注
    const fieldSheet = sheetRows(wb, ['爬取字段', '字段'])
    if (fieldSheet.length) {
      const list = fieldSheet
        .filter((row) => !/字段名|^字段$/i.test(String(row[0] ?? '')))
        .map((row) => ({
          name: String(row[0] ?? '').trim(),
          type: String(row[1] ?? '').trim() || '文本',
          note: String(row[2] ?? '').trim()
        }))
        .filter((f) => f.name)
      if (list.length) {
        saveFieldRows(list)
        used.push(`爬取字段 ${list.length} 个`)
      }
    }

    // ③ 密码本表：网站 / 账号 / 密码
    const siteRows = sheetRows(wb, ['密码本', '账号'])
    if (siteRows.length) {
      const list = siteRows
        .filter((row) => !/网站|网址|site/i.test(String(row[0] ?? '')))
        .map((row) => ({
          site: String(row[0] ?? '').trim(),
          username: String(row[1] ?? '').trim(),
          password: String(row[2] ?? '')
        }))
        .filter((s) => s.site || s.username)
      persistSites(list)
      used.push(`密码本 ${list.length} 条`)
    }

    // ④ 推荐链接表：第一列是链接
    const linkRows = sheetRows(wb, ['推荐链接', '链接'])
    if (linkRows.length) {
      const list = linkRows
        .map((row) => String(row[0] ?? '').trim())
        .filter((href) => href && !/^(推荐)?链接$|^网址$|^url$/i.test(href))
      persistLinks(list)
      used.push(`推荐链接 ${list.length} 条`)
    }

    if (!used.length) throw new Error('这个表格里没有可用的配置项（配置 / 密码本 / 推荐链接）')

    showSuccessToast('配置已导入')
    log(`已导入配置：${used.join('、')}`)
    log(`来源文件：${file.filePath}`)
  } catch (err) {
    showFailToast(`导入配置失败：${err.message}`)
  }
}

function buildPasswordBook () {
  return {
    sites: passwordSites.value.map((s) => ({
      site: s.site,
      username: s.username,
      password: s.password
    }))
  }
}

// ============ 主流程 ============
async function start () {
  if (running.value) return
  if (!bridgeReady.value) return showFailToast('请用 Electron 启动（npm run dev 或 npm start）')
  if (!topic.value.trim()) return showToast('请输入爬取主题')
  if (!fields.value.length) return showToast('请先上传包含字段名的 Excel 模板')
  if (!links.value.length && !expandSites.value) {
    return showToast('请添加起始链接，或打开「自动扩展站点」让 AI 帮忙找')
  }

  running.value = true
  rows.value = []
  issues.value = []
  aiSummary.value = ''
  plan.value = null
  logs.value = []

  try {
    const payloadTopic = topic.value.trim()

    // 必须先有保存过的爬取方案才能开始
    if (!planReady.value) {
      throw new Error('还没有爬取方案：请先点「爬取方案」→「开始规划」→「保存」')
    }
    const searchKeywords = activeKeywords.value
    log(`本轮按 ${searchKeywords.length} 个关键词批量搜索：${searchKeywords.join('、')}`)

    // 第 1 步：站点调研 —— AI 推荐站点、搜索引擎找页面，并采集真实页面结构
    setProgress(2, 'AI 正在推荐相关站点…')
    log(`开始任务：${payloadTopic}`)
    const analysis = unwrap(
      await api.analyzeSites(
        plain({
          topic: payloadTopic,
          rules: rules.value,
          links: links.value,
          expand: expandSites.value,
          searchKeywords
        })
      )
    )

    if (analysis.aiSites?.length) {
      log(`AI 推荐了 ${analysis.aiSites.length} 个站点：`)
      analysis.aiSites.forEach((s) => log(`  ${s.name || s.url}${s.reason ? `（${s.reason}）` : ''}`))
    }
    if (analysis.keywords?.length) log(`检索关键词：${analysis.keywords.join('、')}`)
    if (analysis.topicKeywords?.length) log(`主题核心词：${analysis.topicKeywords.join('、')}`)
    if (analysis.searchKeyword) log(`站内检索用词：${analysis.searchKeyword}`)

    if (!analysis.sites?.length) {
      const detail = analysis.errors?.length ? `：${analysis.errors[0]}` : ''
      throw new Error(`没有可用的站点${detail}`)
    }

    log(`页面结构分析完成，可用站点 ${analysis.sites.length} 个：`)
    analysis.sites.forEach((s) => {
      const pages = (s.listPages || [])
        .map((p) => {
          const tag = p.kind ? `[${p.kind}] ` : ''
          const sel = p.bestSelector ? `（${p.bestSelector}，命中 ${p.bestCount} 条）` : ''
          return `${tag}${p.url}${sel}`
        })
        .join('；')
      log(`  [${s.source}] ${s.title || s.url}`)
      log(`     列表页：${pages || '未识别到列表结构'}`)
      log(`     可批量搜：${s.canBatchSearch ? '是（会按每个关键词各搜一次）' : '否（只抓该列表页）'}`)
      if (s.sampleDetailUrl) log(`     详情页样本：${s.sampleDetailUrl}`)
    })
    ;(analysis.errors || []).forEach((e) => log(`跳过：${e}`))

    // 第 2 步：AI 规划（带上真实页面结构，选择器不再靠猜）
    setProgress(17, 'AI 正在根据页面结构生成爬取计划…')
    plan.value = unwrap(
      await api.aiPlan(
        plain({
          topic: payloadTopic,
          rules: rules.value,
          links: links.value,
          fields: fields.value,
          fieldDefs: fieldRows.value,
          dateRange: dateRange.value,
          // 搜索计划：规划阶段会把"站点任务"按每个关键词展开成多个任务
          searchKeywords,
          searchPlan: searchPlan.value.plan
        })
      )
    )
    log(`AI 规划完成，共 ${plan.value.tasks.length} 个任务`)
    const keywordTasks = plan.value.tasks.filter((t) => t.keyword).length
    if (keywordTasks) log(`其中 ${keywordTasks} 个任务是按关键词展开的（多关键词批量搜索）`)
    plan.value.tasks.slice(0, 12).forEach((t, i) => {
      const sel = t.selector ? `，选择器 ${t.selector}` : ''
      const kw = t.keyword ? `[${t.keyword}] ` : ''
      log(`  任务${i + 1}：${kw}${t.url}${sel}${t.followDetail === false ? '（不跟进详情页）' : ''}`)
    })
    if (plan.value.tasks.length > 12) {
      log(`  …… 其余 ${plan.value.tasks.length - 12} 个任务不再逐条列出`)
    }

    // 第 3 步：本地抓取
    setProgress(20, '正在启动 Playwright 抓取…')
    const crawled = unwrap(
      await api.crawlStart(
        plain({
          plan: plan.value,
          passwordBook: buildPasswordBook(),
          fields: fields.value,
          rules: rules.value,
          dateRange: dateRange.value
        })
      )
    )
    rows.value = (crawled.rows || []).map((row, i) => ({ __index: i + 1, ...row }))
    const stats = crawled.stats || {}
    if (stats.dateRule) log(`时间范围过滤：${stats.dateRule}`)
    if (stats.blockedPages) log(`已跳过 ${stats.blockedPages} 个命中人机验证的详情页`)
    if (stats.droppedBlocked) log(`已丢弃 ${stats.droppedBlocked} 条风控/验证码页面的无效数据`)
    if (stats.droppedIrrelevant) log(`已丢弃 ${stats.droppedIrrelevant} 条与主题无关的记录`)
    if (stats.droppedByDate) log(`已丢弃 ${stats.droppedByDate} 条不符合时间要求的记录`)
    if (stats.droppedJunk) log(`已丢弃 ${stats.droppedJunk} 条导航/无效条目`)
    if (stats.undated) log(`其中 ${stats.undated} 条没有日期，无法判断时间范围，已保留`)
    if (stats.deduped) log(`已按「标题 + 发布日期」去掉 ${stats.deduped} 条重复记录`)

    // 搜索日志：每个关键词命中多少条，一眼看出哪个词有效、哪个词白搜了
    const keywordHits = new Map()
    ;(stats.tasks || []).forEach((t) => {
      if (!t.keyword) return
      const item = keywordHits.get(t.keyword) || { rows: 0, pages: 0 }
      item.rows += t.rows || 0
      item.pages += t.listPages || 0
      keywordHits.set(t.keyword, item)
    })
    if (keywordHits.size) {
      log(
        `关键词命中：${[...keywordHits.entries()].map(([k, it]) => `${k}=${it.rows}条/${it.pages}页`).join('、')}`
      )
      const missed = [...keywordHits.entries()].filter(([, it]) => !it.rows).map(([k]) => k)
      if (missed.length) log(`这些关键词一条都没搜到：${missed.join('、')}`)
    }

    log(`抓取结束，得到 ${rows.value.length} 条与主题相关的记录`)
    if (!rows.value.length) {
      log('提示：这一轮没抓到相关内容，可以换个更具体的主题或补充推荐链接后重试')
    }
    if (crawled.stopped) log('抓取被手动终止')

    // 第 4 步：AI 校验
    if (rows.value.length) {
      setProgress(86, 'AI 正在清洗、去重、对齐字段…')
      try {
        const checked = unwrap(
          await api.aiValidate(
            plain({
              topic: payloadTopic,
              fields: fields.value,
              fieldDefs: fieldRows.value,
              rows: crawled.rows,
              rules: rules.value,
              dateRange: dateRange.value
            })
          )
        )
        const checkedRows = checked.rows || []
        issues.value = checked.issues || []
        aiSummary.value = checked.summary || ''

        if (checkedRows.length) {
          rows.value = checkedRows.map((row, i) => ({ __index: i + 1, ...row }))
          log(`AI 校验完成，最终 ${rows.value.length} 条记录`)
        } else {
          // 准确度优先：AI 判为全部不符就清空，但把被剔除的列出来供你核对
          const titleField = fields.value.find((f) => /(标题|名称|项目|公告)/.test(f)) || fields.value[0]
          rows.value = []
          log('AI 校验后没有留下任何数据：所有记录都被判为与主题或规则不符')
          ;(crawled.rows || []).slice(0, 5).forEach((row) => {
            const title = String(row[titleField] ?? '').replace(/\s+/g, ' ').slice(0, 50)
            log(`  被剔除：${title}`)
          })
          log('  如果觉得判断有误，可以放宽「规则设置」里的要求后重试')
        }
        issues.value.forEach((it) => log(`校验提示：${it}`))
      } catch (err) {
        log(`AI 校验失败，已保留原始抓取结果：${err.message}`)
      }
    } else {
      log('没有抓到数据，跳过 AI 校验')
    }

    setProgress(100, '完成，确认结果后即可下载 Excel')
    showSuccessToast(rows.value.length ? '抓取完成' : '没有抓到数据')
  } catch (err) {
    log(`失败：${err.message}`)
    showFailToast(err.message)
    setProgress(0, '')
  } finally {
    running.value = false
    log('—— 本次运行结束 ——')
  }
}

async function stop () {
  try {
    await api.crawlStop()
    log('已请求停止，等待当前页面处理完成…')
  } catch (err) {
    showFailToast(err.message)
  }
}

// ============ 导出 Excel（按「编辑爬取内容」里的字段定义生成表头） ============

/** 按数据类型给单元格取值：数字/金额能被 Excel 当数值（可排序求和），其余保持文本 */
function cellValue (value, type) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/数字|金额|百分比/.test(String(type || ''))) {
    const cleaned = text.replace(/[,，\s]/g, '').replace(/%$/, '')
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned)
  }
  return text
}

async function downloadExcel () {
  if (!rows.value.length) return showToast('还没有可导出的数据')

  try {
    const headers = fields.value
    const defs = fieldRows.value
    const wb = XLSX.utils.book_new()

    const aoa = [
      headers,
      ...rows.value.map((row) => defs.map((f) => cellValue(row[f.name], f.type)))
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '爬取结果')

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const baseName = (topic.value.trim() || 'crawl-result').replace(/[\\/:*?"<>|]/g, '_')

    const res = unwrap(
      await api.saveExcel({
        data: new Uint8Array(buffer),
        fileName: `${baseName}-${stamp}.xlsx`
      })
    )

    if (res.saved) {
      showSuccessToast('已保存')
      log(`Excel 已保存：${res.filePath}`)
      await api.showInFolder(res.filePath)
    } else {
      log('已取消保存')
    }
  } catch (err) {
    showFailToast(`导出失败：${err.message}`)
  }
}
</script>

<template>
  <div class="app">
    <!-- 顶部：主题 + 爬取内容 -->
    <header class="panel top">
      <div class="top-row">
        <van-field
          v-model="topic"
          class="topic"
          clearable
          placeholder="请输入爬取主题，例如：风电项目招标公告"
        >
          <template #left-icon>
            <van-icon name="search" color="#8f959e" />
          </template>
        </van-field>

        <van-button plain type="primary" icon="edit" @click="showContent = true">抓取字段</van-button>
        <van-button
          plain
          type="primary"
          icon="bar-chart-o"
          :disabled="!topic.trim() || running"
          @click="openPlanPopup"
        >
          爬取方案<em v-if="planReady"> · {{ activeKeywords.length }} 个关键词</em>
        </van-button>
      </div>

      <div class="field-row">
        <span class="field-label">待抓字段</span>
        <template v-if="fields.length">
          <van-tag v-for="f in fieldRows" :key="f.name" plain type="primary" class="field-tag">
            {{ f.name }}<em class="tag-type">{{ f.type }}</em>
          </van-tag>
        </template>
        <span v-else class="hint">还没有字段，点上方「抓取字段」添加</span>
      </div>
    </header>

    <!-- 使用说明（折叠，不占地方） -->
    <section class="panel intro">
      <van-collapse v-model="showIntro">
        <van-collapse-item title="使用说明：每个按钮是做什么的、需要你填什么、下面展板看什么" name="intro">
          <div class="intro-body">
            <p class="intro-h">① 需要你先填的东西</p>
            <ul>
              <li><b>爬取主题</b>（最上方）：一句话说明要找什么，例如「风电项目招标公告」。AI 靠它推荐站点、生成关键词。</li>
              <li><b>抓取字段</b>：定义要抓哪些列（字段名 / 数据类型 / 备注），默认是「日期、标题、正文」。字段名就是最后 Excel 的列名；数据类型和备注会一起告诉 AI，帮它找准位置。</li>
            </ul>

            <p class="intro-h">② 功能按钮的作用</p>
            <ul>
              <li><b>爬取方案</b>：主题填好后才能点。弹窗里点「开始规划」，AI 结合主题、规则、字段、爬取时间段把主题扩展成 8~15 个关键词，并给出每个词的搜索方式、时间范围和翻页数；关键词和翻页数都能改，点「保存」后「开始爬取」才会亮。改了主题会提醒你清掉旧方案、重新规划。</li>
              <li><b>规则设置</b>：补充筛选要求，例如「只要九月份的」「排除土地出让」。会随规划、抓取、清洗三处一起生效。</li>
              <li><b>密码本</b>：需要登录才能看到内容的站点，填域名 + 账号 + 密码；抓取时会自动登录。</li>
              <li><b>推荐链接</b>：你指定一定要抓的网站，优先级最高（可只写域名）。</li>
              <li><b>爬取时间段</b>：点日历选择日期区间，明确只抓这段时间的内容；<b>优先级高于规则设置里的时间要求</b>，两者冲突时以这里为准，清空则回到由规则决定。</li>
              <li><b>导入 / 导出配置</b>：把规则、抓取字段、时间段、密码本、推荐链接一起存成一份表格，换电脑或重装后导入即可恢复。</li>
              <li><b>自动扩展站点</b>：开启后 AI 会额外推荐站点、用搜索引擎补充页面；关掉则只抓你给的推荐链接。</li>
              <li><b>开始爬取 / 停止</b>：启动或中止这一轮任务（没有保存过爬取方案时是灰的）。</li>
              <li><b>下载 Excel</b>：把展板「抓取结果」里的数据按字段导出成表格。</li>
              <li><b>设置</b>：填 AI 接口地址、密钥、模型，<b>测试通过才能保存</b>；配置好之前「爬取方案」和「开始爬取」都不能用。</li>
            </ul>

            <p class="intro-h">③ 下面展板展示什么</p>
            <ul>
              <li><b>运行日志</b>（默认面板）：每一步在做什么、跳过了哪些站点、每个关键词命中多少条、为什么剔除数据，出问题时先看这里；右上角「导出日志」可存成表格。</li>
              <li><b>抓取结果</b>：抓取并清洗后的数据，一行一条记录（点「下载 Excel」导出这个内容）。</li>
              <li><b>AI 反馈</b>：AI 清洗时发现的问题（重复、字段缺失、被判无关的条目等），和日志分开展示、互不遮挡。</li>
            </ul>
          </div>
        </van-collapse-item>
      </van-collapse>
    </section>

    <!-- 中部：五个弹窗/选择器入口 -->
    <section class="panel actions">
      <van-button plain size="small" icon="records" @click="showRule = true">
        规则设置<em v-if="rules"> · 已配置</em>
      </van-button>
      <van-button plain size="small" icon="lock" @click="showPassword = true">
        密码本<em v-if="passwordSites.length"> · {{ passwordSites.length }} 个站点</em>
      </van-button>
      <van-button plain size="small" icon="link-o" @click="showLink = true">
        推荐链接<em v-if="links.length"> · {{ links.length }} 个</em>
      </van-button>

      <van-button plain size="small" icon="setting-o" @click="importConfig">导入配置</van-button>
      <van-button plain size="small" icon="down" @click="exportConfig">导出配置</van-button>

      <label class="switch">
        <van-switch v-model="expandSites" size="16" />
        <span>自动扩展站点</span>
      </label>

      <div class="spacer" />

      <van-button plain size="small" icon="calendar-o" @click="showRange = true">
        爬取时间段<em> · {{ rangeLabel }}</em>
      </van-button>
      <van-button
        v-if="dateRange"
        plain
        size="small"
        icon="cross"
        title="清除时间段，时间要求改由规则设置决定"
        @click="clearRange"
      />

      <span v-if="configInfo" class="meta">
        模型 {{ configInfo.model }} · 超时 {{ configInfo.requestTimeout / 1000 }}s · 最多
        {{ configInfo.maxPages }} 页 · {{ configInfo.headless ? '无头' : '显示浏览器' }}
      </span>
    </section>

    <!-- 展板：运行日志 / 抓取结果 / AI 反馈 三块切换（默认展示日志） -->
    <main class="content">
      <section class="panel board">
        <div class="board-head">
          <div class="tabs">
            <button type="button" class="tab" :class="{ on: boardTab === 'log' }" @click="boardTab = 'log'">
              运行日志<em v-if="logs.length"> · {{ logs.length }}</em>
            </button>
            <button type="button" class="tab" :class="{ on: boardTab === 'rows' }" @click="boardTab = 'rows'">
              抓取结果<em v-if="rows.length"> · {{ rows.length }} 条</em>
            </button>
            <button type="button" class="tab" :class="{ on: boardTab === 'ai' }" @click="boardTab = 'ai'">
              AI 反馈<em v-if="issues.length"> · {{ issues.length }} 条</em>
            </button>
          </div>
          <van-button
            v-if="boardTab === 'log'"
            plain
            size="mini"
            icon="down"
            :disabled="!logs.length"
            @click="exportLog"
          >
            导出日志
          </van-button>
        </div>

        <div v-show="boardTab === 'log'" ref="logBox" class="board-body scroll">
          <p v-if="!logs.length" class="log-empty">等待开始…</p>
          <p v-for="(item, i) in logs" :key="i" class="log-line">
            <span class="log-time">{{ item.time }}</span>{{ item.text }}
          </p>
        </div>

        <div v-show="boardTab === 'rows'" class="board-body">
          <ResultTable :fields="fields" :rows="rows" />
        </div>

        <div v-show="boardTab === 'ai'" class="board-body scroll">
          <p v-if="aiSummary" class="ai-summary">AI：{{ aiSummary }}</p>
          <ul v-if="issues.length" class="issue-list">
            <li v-for="(it, i) in issues" :key="i">{{ it }}</li>
          </ul>
          <van-empty
            v-if="!issues.length && !aiSummary"
            image-size="60"
            description="还没有 AI 反馈，爬取完成后这里会列出 AI 校验发现的问题"
          />
        </div>
      </section>
    </main>

    <!-- 底部：进度 + 操作 -->
    <footer class="panel bottom">
      <div class="progress-area">
        <van-progress
          :percentage="progress.percent"
          :show-pivot="false"
          :color="progress.percent === 100 ? '#07c160' : '#1989fa'"
          track-color="#eef0f3"
          stroke-width="6"
        />
        <div class="progress-text">
          <span class="percent">{{ progress.percent }}%</span>
          <span class="msg">{{ progress.message || (running ? '处理中…' : '就绪') }}</span>
        </div>
      </div>

      <van-button
        v-if="!running"
        plain
        type="primary"
        icon="play-circle-o"
        :disabled="!planReady"
        @click="start"
      >
        开始爬取
      </van-button>
      <van-button v-else plain type="danger" icon="stop-circle-o" @click="stop">停止</van-button>

      <van-button plain type="success" icon="down" :disabled="!rows.length" @click="downloadExcel">
        下载 Excel
      </van-button>

      <van-button plain icon="setting-o" @click="showSettings = true">设置</van-button>
    </footer>

    <!-- 弹窗/选择器 -->
    <ContentPopup v-model="showContent" :fields="fieldRows" @save="saveFieldRows" />
    <SearchPlanPopup
      v-model="showSearchPlan"
      :keywords="searchPlan.keywords"
      :plan="searchPlan.plan"
      :selected="pickedKeywords"
      :planning="planning"
      :has-plan="searchPlan.keywords.length > 0"
      @plan="runPlanning"
      @save="savePickedKeywords"
    />
    <SettingsPopup v-model="showSettings" :config="configInfo" @saved="onSettingsSaved" />
    <RulePopup v-model="showRule" :rules="rules" :fields="fields" @save="saveRules" />
    <PasswordPopup v-model="showPassword" :sites="passwordSites" @save="saveSites" />
    <LinksPopup v-model="showLink" :links="links" @save="saveLinks" />

    <van-calendar
      v-model:show="showRange"
      type="range"
      :min-date="rangeMin"
      :max-date="rangeMax"
      :default-date="rangeDefault"
      :allow-same-day="true"
      :show-confirm="true"
      color="#1989fa"
      title="选择爬取时间段（优先于规则里的时间要求）"
      confirm-text="确定"
      @confirm="onRangeConfirm"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 14px;
  gap: 10px;
  overflow: hidden;
}

.panel {
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
}

/* 顶部 */
.top {
  flex: none;
}

.top-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topic {
  flex: 1;
  min-height: 44px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafbfc;
}

.field-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.field-label {
  color: var(--text-3);
  font-size: 12px;
}

.field-tag {
  font-size: 12px;
}

.tag-type {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.65;
}

.hint {
  color: var(--text-3);
  font-size: 12px;
}

/* 使用说明（折叠行） */
.intro {
  flex: none;
  padding: 0;
  overflow: hidden;
}

.intro-body {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.8;
}

.intro-h {
  margin: 4px 0 2px;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
}

.intro-body ul {
  margin: 0;
  padding-left: 18px;
}

.intro-body li {
  margin: 2px 0;
}

.intro-body b {
  color: var(--text-1);
}

/* 操作区 */
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  row-gap: 8px;
  /* 按钮变多了，窗口窄时允许换行，避免挤掉右边的配置信息 */
  flex-wrap: wrap;
  flex: none;
}

.actions em {
  font-style: normal;
  color: var(--text-3);
}

.bottom em {
  font-style: normal;
  color: var(--text-3);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 2px;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}

.spacer {
  flex: 1;
}

.meta {
  color: var(--text-3);
  font-size: 12px;
}

/* 内容区 */
.content {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}

/* 展板：顶部 tab 切换（运行日志 / 抓取结果 / AI 反馈） */
.board {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  overflow: hidden;
}

.board-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tab {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.tab em {
  font-style: normal;
  color: var(--text-3);
  font-size: 12px;
}

.tab:hover {
  background: #f2f3f5;
}

.tab.on {
  border-color: #cfe0f8;
  background: #eef5ff;
  color: var(--brand);
  font-weight: 600;
}

.tab.on em {
  color: var(--brand);
}

.board-body {
  flex: 1;
  min-height: 0;
}

/* 日志和 AI 反馈面板自己滚动；结果表由 ResultTable 内部滚动 */
.board-body.scroll {
  overflow: auto;
  padding-top: 8px;
  padding-right: 4px;
}

.log-empty {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}

.log-line {
  margin: 0 0 6px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.log-time {
  margin-right: 8px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.ai-summary {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f6f8fb;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.7;
}

.issue-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.8;
}

.issue-list li {
  margin: 2px 0;
}

/* 底部 */
.bottom {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: none;
}

.progress-area {
  flex: 1;
  min-width: 0;
}

.progress-text {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 12px;
}

.percent {
  color: #0a66c2;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.msg {
  overflow: hidden;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
