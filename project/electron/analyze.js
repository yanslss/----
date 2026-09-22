import pw from 'playwright'
import config from '../config.js'
import { normalizeUrl, autoScroll, waitForBody, isPendingText, swapProtocol } from './crawler.js'

const { chromium } = pw

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 列表页里"像公告"的链接文字，用来挑详情页样本、找站内栏目页
const LIST_WORD = /(招标|投标|采购|公告|公示|中标|成交|询价|竞争性|磋商|变更|答疑|项目|交易|结果)/

// ============================================================
// 以下两个函数会在浏览器里执行，不能引用外部变量
// ============================================================

/** 列表页摘要：找出重复块（候选列表选择器）、链接清单、栏目入口 */
function listDigest () {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const esc = (v) => (window.CSS && window.CSS.escape ? window.CSS.escape(v) : String(v))
  const dateRe = /\d{4}\s*[-/年.]\s*\d{1,2}/
  const wordRe = /(招标|投标|采购|公告|公示|中标|成交|询价|项目|结果|变更|预告)/

  // 1) 链接清单
  const links = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href
    if (!/^https?:/i.test(href)) continue
    const text = clean(a.textContent)
    if (text.length < 4 || text.length > 100) continue
    if (seen.has(href)) continue
    seen.add(href)
    links.push({ text: text.slice(0, 60), href })
    if (links.length >= 100) break
  }

  // 2) 重复块候选
  // 只说"同一种子节点出现 5 次以上"不够 —— 导航菜单也符合，
  // 所以要打分：带日期、含公告类关键词、子项里有链接、文本不能太短。
  const parents = new Set()
  for (const el of document.querySelectorAll('body *')) {
    if (el.parentElement) parents.add(el.parentElement)
  }

  const candidates = []
  const seenSel = new Set()

  for (const p of parents) {
    const kids = Array.from(p.children)
    if (kids.length < 5) continue

    const groups = new Map()
    for (const k of kids) {
      const sig = k.tagName.toLowerCase() + '|' + Array.from(k.classList).sort().join('.')
      if (!groups.has(sig)) groups.set(sig, [])
      groups.get(sig).push(k)
    }

    for (const [sig, items] of groups) {
      if (items.length < 5) continue
      const parts = sig.split('|')
      const tag = parts[0]
      const cls = parts[1] ? parts[1].split('.').filter(Boolean).map(esc) : []

      const parentSel =
        p.tagName.toLowerCase() +
        (p.id ? '#' + esc(p.id) : '') +
        (p.classList.length ? '.' + Array.from(p.classList).map(esc).join('.') : '')
      const itemSel = parentSel + ' > ' + tag + (cls.length ? '.' + cls.join('.') : '')
      if (seenSel.has(itemSel)) continue
      seenSel.add(itemSel)

      const first = items[0]
      const sample = clean(first.textContent).slice(0, 100)
      // 列表项本身可能就是 <a>，这种情况下 querySelector 查不到自己
      const hasLink = first.tagName.toLowerCase() === 'a' || !!first.querySelector('a[href]')

      let score = Math.min(items.length, 30)
      if (dateRe.test(sample)) score += 18
      if (wordRe.test(sample)) score += 12
      if (hasLink) score += 8
      if (sample.length < 12) score -= 12 // 菜单项通常很短

      candidates.push({ selector: itemSel, count: items.length, hasLink, sample, score, items })
    }
  }

  candidates.sort((a, b) => b.score - a.score)

  // 只给排在前面的候选补"条目内链接"，用来挑详情页样本
  const lists = candidates.slice(0, 8).map((c) => {
    const itemLinks = []
    for (const it of c.items.slice(0, 6)) {
      const a = it.tagName.toLowerCase() === 'a' ? it : it.querySelector('a[href]')
      const href = a ? a.href : ''
      if (!/^https?:/i.test(href)) continue
      itemLinks.push({ text: clean(it.textContent).slice(0, 60), href })
      if (itemLinks.length >= 4) break
    }
    return {
      selector: c.selector,
      count: c.count,
      hasLink: c.hasLink,
      score: c.score,
      sample: c.sample,
      itemLinks
    }
  })

  // 3) 栏目入口候选：站内短文本链接。
  // 必须单独扫一遍，不能复用上面的 links —— links 要求文字至少 4 个字，
  // "风电""光伏"这种两个字的核心栏目入口会被它滤掉，栏目发现就永远找不到。
  // 这里不做关键词筛选 —— 真正筛"这个栏目是否和主题相关"的事交给上层（它知道主题核心词）。
  const columns = []
  const colSeen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href
    if (!/^https?:/i.test(href)) continue
    if (href === location.href || colSeen.has(href)) continue
    const text = clean(a.textContent)
    const len = text.length
    if (len < 2 || len > 20) continue
    colSeen.add(href)
    columns.push({ text: text.slice(0, 30), href })
    if (columns.length >= 60) break
  }

  // 4) 检索表单信息：存到摘要里，这样不用回到页面就能拼出检索地址
  let searchForm = null
  for (const input of document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')) {
    const hint = [input.name, input.id, typeof input.className === 'string' ? input.className : '', input.placeholder]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!/search|keyword|query|关键词|关键字|搜索|检索|查询|\bkw\b|\bwd\b|\bq\b|\bkey\b/i.test(hint)) continue

    const form = input.closest('form')
    if (!form) continue
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') continue

    const param = input.name || input.id
    if (!param) continue

    try {
      searchForm = {
        action: new URL(form.getAttribute('action') || location.href, location.href).href,
        param
      }
    } catch (_) {
      searchForm = null
    }
    if (searchForm) break
  }

  const bodyText = clean(document.body ? document.body.innerText : '')
  return {
    url: location.href,
    title: clean(document.title),
    lists,
    links: links.slice(0, 100),
    columns,
    searchForm,
    text: bodyText.slice(0, 1200)
  }
}

/** 详情页摘要：候选标题、日期、正文容器 */
function detailDigest () {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const esc = (v) => (window.CSS && window.CSS.escape ? window.CSS.escape(v) : String(v))

  // 生成一个能唯一定位的选择器：优先 id，其次 tag + class，最后补 :nth-of-type
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return ''
    if (el.id) return '#' + esc(el.id)

    const parts = []
    let cur = el
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      let part = cur.tagName.toLowerCase()
      const cls = Array.from(cur.classList).slice(0, 2)
      if (cls.length) {
        part += '.' + cls.map(esc).join('.')
      } else if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName)
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`
      }
      parts.unshift(part)

      const joined = parts.join(' > ')
      try {
        if (document.querySelectorAll(joined).length === 1) return joined
      } catch (_) { /* 选择器非法，继续往上层找 */ }

      cur = cur.parentElement
      if (cur && cur.id) {
        parts.unshift('#' + esc(cur.id))
        return parts.join(' > ')
      }
    }
    return parts.join(' > ')
  }

  // 标题：优先 h1；没有 h1 就用常见标题类名；再不行找和 <title> 一致的元素
  const docTitle = clean(document.title)
  let titleEl = document.querySelector('h1')

  if (!titleEl) {
    for (const el of document.querySelectorAll(
      'h2, h3, .title, .tit, .detail-title, .article-title, .content-title, .news-title, .con-title'
    )) {
      const t = clean(el.textContent)
      if (t.length >= 6 && t.length <= 120) {
        titleEl = el
        break
      }
    }
  }

  if (!titleEl && docTitle) {
    const head = docTitle.split(/[_|｜\-－]/)[0].trim()
    if (head.length >= 6) {
      let bestDiff = 999
      for (const el of document.querySelectorAll('div,span,p,h2,h3,h4,strong')) {
        const t = clean(el.textContent)
        if (t.length < 6 || t.length > 120) continue
        if (t !== head && !t.includes(head) && !head.includes(t)) continue
        // 取和标题长度最接近的那个，避免选中"标题 + 一堆角标"的外层容器
        const diff = Math.abs(t.length - head.length)
        if (diff < bestDiff) {
          bestDiff = diff
          titleEl = el
        }
      }
    }
  }

  const title = clean(titleEl ? titleEl.textContent : docTitle)

  // 日期候选：短文本 + 日期格式 + 没有子元素
  const dateRe = /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/
  const dates = []
  for (const el of document.querySelectorAll('span,div,p,td,em,li,time,strong')) {
    const t = clean(el.textContent)
    if (!t || t.length > 30 || el.children.length > 0) continue
    if (!dateRe.test(t)) continue
    dates.push({ selector: sel(el), text: t })
    if (dates.length >= 8) break
  }

  // 正文候选：文本量大、不是纯容器、而且链接占比低（正文里几乎没有链接）
  const blocks = []
  for (const el of document.querySelectorAll('article,section,div,td,main')) {
    const t = clean(el.textContent)
    if (t.length < 150 || t.length > 8000) continue

    let childMax = 0
    for (const c of el.children) childMax = Math.max(childMax, clean(c.textContent).length)
    if (childMax > t.length * 0.85) continue // 只是外层容器

    let linkLen = 0
    for (const a of el.querySelectorAll('a')) linkLen += clean(a.textContent).length
    const density = linkLen / t.length

    // 正文字符丰富度：像"公司名重复十遍"这种推广模块，字符重复率极高
    const uniqueRatio = new Set(t.slice(0, 1500).split('')).size / Math.min(t.length, 1500)

    const mark = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')
    const nameBonus = /(content|article|text|body|bdtext|zwcon|正文)/i.test(mark) ? 10 : 0
    const wordBonus = /(公告正文|正文|项目概况|采购需求|招标公告|采购公告|中标结果|磋商|一、)/.test(t) ? 12 : 0

    // 文本越长越可能是正文，但"链接占比 / 重复度"更能区分正文与页面容器
    let score = Math.min(t.length, 3000) / 300 + nameBonus + wordBonus
    if (density > 0.3) score -= 30
    else if (density > 0.12) score -= 16
    else if (density > 0.06) score -= 8
    if (uniqueRatio < 0.22) score -= 20
    if (t.length < 300) score -= 5

    blocks.push({
      selector: sel(el),
      length: t.length,
      linkDensity: Number(density.toFixed(2)),
      score: Number(score.toFixed(1)),
      text: t.slice(0, 260)
    })
  }
  blocks.sort((a, b) => b.score - a.score)

  const bodyText = clean(document.body ? document.body.innerText : '')
  return {
    url: location.href,
    title,
    titleSelector: titleEl ? sel(titleEl) : '',
    dates: dates.slice(0, 6),
    blocks: blocks.slice(0, 8),
    text: bodyText.slice(0, 1200)
  }
}

// ============================================================
// 打开页面并取摘要
// ============================================================

// 调研阶段的导航超时：只要服务器开始响应就算成功，所以可以给宽松一点
const NAV_TIMEOUT = 30000

// 连接层面的失败：域名能解析但端口不通（https 最常见），换 http 往往就通了
const CONN_FAILURE =
  /(ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_SSL|ERR_CERT)/i

/**
 * 给任意 Promise 加超时。
 * 浏览器相关调用（close / evaluate / newContext）在页面卡住时会一直不返回，
 * 必须由我们自己兜底，否则整个流程就"卡住不动"了。
 */
function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}秒）`)), ms))
  ])
}

/**
 * 带自我修复的跳转。
 * 关键点有三个：
 * 1. 用 waitUntil:'commit'：只要服务器开始响应就算导航成功。很多正规门户（如中国电力网）
 *    完整加载要十几秒，用 domcontentloaded 或 load 做等待条件会把它们误判成打不开。
 *    正文是否渲染出来，交给 waitForBody 去等。
 * 2. 一次导航失败（尤其"被中断"）后页面上会残留未完成的跳转，
 *    它会打断紧接着的每一次跳转 —— 表现为后面所有站点全部失败，所以必须换一个干净页面重试。
 * 3. 连接层失败时换协议重试：只有 http 能通的站点（https 端口超时）否则整站都会被跳过。
 */
async function gotoWithRecovery (session, url, onProgress, timeout = NAV_TIMEOUT) {
  const attempt = (target) => session.page.goto(target, { waitUntil: 'commit', timeout })
  const alt = swapProtocol(url)

  let firstErr = null
  try {
    await attempt(url)
  } catch (err) {
    firstErr = err
  }

  if (firstErr) {
    const reason = String(firstErr.message || firstErr).split('\n')[0]
    // 用户给的链接没写协议时我们会补成 https，但有些正规站点只开了 http
    // （https 端口直接超时，如中国电力网、风能协会），这时只能换协议才救得回来；
    // 而"被其他跳转打断""超时"这类失败重试原地址更有效。
    const useAlt = !!alt && CONN_FAILURE.test(reason)
    const target = useAlt ? alt : url

    onProgress?.(
      useAlt
        ? `${url} 连接不上（${reason}），换 ${alt.split(':')[0]} 重试`
        : `${url} 打开失败（${reason}），换一个干净页面重试`
    )
    // 失败后页面上会残留未完成的跳转，它会让紧接着的跳转也失败，所以必须换干净页面
    await session.reset()
    await attempt(target)
  }

  // DOM 没出来也继续往下走，由摘要阶段判断内容是否足够
  await session.page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
  await waitForBody(session.page, 15000)
}

async function openDigest (session, url, digestFn, onProgress) {
  await gotoWithRecovery(session, url, onProgress)
  await session.page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
  await autoScroll(session.page)
  await session.page.waitForTimeout(700)
  return await digestCurrent(session, digestFn)
}

/**
 * 取当前页面的摘要。列表常常是异步渲染的，第一遍没识别出列表就再等一轮，
 * 避免"检索结果还没出来就判定没有数据"。
 */
async function digestCurrent (session, digestFn, retries = 1) {
  const readDigest = () => withTimeout(session.page.evaluate(digestFn), 25000, '解析页面结构')

  let digest = await readDigest()
  for (let i = 0; i < retries && digestFn === listDigest && !looksLikeList(digest); i++) {
    await session.page.waitForTimeout(2200)
    await autoScroll(session.page)
    digest = await readDigest()
  }

  // 页面还停在"加载中 / 暂无数据"占位：真正的列表是异步渲染的，得继续等它出来。
  // 不等的话选出来的"列表"其实是筛选条外壳，拿它判主题相关性会得出
  // "这个站点和主题无关"，把整站误杀（chinabidding.cc 就是这么被跳过的）。
  const deadline = Date.now() + 12000
  while (digestFn === listDigest && isPendingText(digest?.text) && Date.now() < deadline) {
    await session.page.waitForTimeout(1500)
    digest = await readDigest()
  }
  return digest
}

/** 入口页像不像"结果列表"：重复块要带日期/公告关键词才算，光有 5 个相同兄弟节点可能只是导航 */
function looksLikeList (digest) {
  return !!(digest?.lists || []).length && (digest.lists[0].score || 0) >= 20
}

// 站点风控/人机验证页面：别把它当成"没有数据"，否则会误判
const BLOCK_HINT =
  /(滑动验证|访问验证|安全验证|人机验证|请按住滑块|请输入验证码|访问过于频繁|请求过于频繁|操作太频繁|verify|captcha|are you a robot|unusual traffic)/i

function isBlockedPage (digest) {
  return BLOCK_HINT.test(`${digest?.title || ''} ${digest?.text || ''}`)
}

/** 某个候选列表选择器选出来的条目，是否真的和主题相关 */
function listCandidateRelevant (list, topicKeywords) {
  if (!topicKeywords.length) return true
  const text = [list?.sample || '', ...(list?.itemLinks || []).map((i) => i.text || '')].join(' ').toLowerCase()
  if (!text.trim()) return false
  return topicKeywords.some((w) => text.includes(String(w).toLowerCase()))
}

/** 这个列表页的内容是否和主题相关（只看"列表行"本身，页面导航里出现主题词不算） */
function isTopicRelevant (digest, topicKeywords) {
  if (!topicKeywords.length) return true

  const samples = []
  for (const list of (digest?.lists || []).slice(0, 3)) {
    if (list.sample) samples.push(list.sample)
    for (const link of list.itemLinks || []) if (link.text) samples.push(link.text)
  }

  const haystack = samples.join(' ').toLowerCase()
  if (!haystack) return true // 没有样例可判断，先放行

  return topicKeywords.some((k) => haystack.includes(String(k).toLowerCase()))
}

/** 两个地址是否指向同一个页面（忽略 query / hash / 末尾斜杠） */
function isSamePage (a, b) {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return (
      ua.hostname === ub.hostname &&
      ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
    )
  } catch (_) {
    return a === b
  }
}

/** 一个链接有多像"详情页"（栏目页/当前页会被扣分） */
function detailScore (href, baseUrl) {
  let path = ''
  let search = ''
  try {
    const u = new URL(href)
    path = u.pathname
    search = u.search
  } catch (_) {
    return -100
  }

  let score = 0
  if (/\d/.test(path)) score += 20
  if (/\.(html?|shtml|jsp|aspx?|php)$/i.test(path)) score += 15
  if (/(content|detail|article|show|info|notice)/i.test(path)) score += 12
  if (/(id|infoId|noticeId|articleId|zbId|guid)=/i.test(search)) score += 10
  if (/\/+$/.test(path) && !/\d/.test(path)) score -= 30 // 以 / 结尾的多半是栏目页
  if (path === '/') score -= 40
  // 是当前列表页的上级目录（"更多"按钮之类），不是详情页
  if (baseUrl && baseUrl.startsWith(href)) score -= 25
  return score
}

/** 从列表摘要里挑一条最像公告详情的链接 */
function pickDetailLink (digest) {
  const lists = [...(digest.lists || [])].sort((a, b) => (b.score || 0) - (a.score || 0))

  let best = ''
  let bestScore = 0

  for (const list of lists) {
    if ((list.score || 0) < 20) continue // 分数太低的多半是导航
    for (const item of list.itemLinks || []) {
      const href = item.href
      if (!href || isSamePage(href, digest.url)) continue
      const score = detailScore(href, digest.url)
      if (score > bestScore) {
        bestScore = score
        best = href
      }
    }
  }

  // 全页链接兜底
  if (!best) {
    for (const item of digest.links || []) {
      if (isSamePage(item.href, digest.url)) continue
      if (!LIST_WORD.test(item.text)) continue
      const score = detailScore(item.href, digest.url)
      if (score > bestScore) {
        bestScore = score
        best = item.href
      }
    }
  }

  // 分数太低说明这不是详情页（比如整个站点都是 JS 路由），宁可不给样本，让 AI 用列表行取数
  return bestScore > 0 ? best : ''
}

/** 从列表摘要里挑站内栏目页（当入口本身不是列表页、或列表跟主题无关时用） */
function pickColumnLinks (digest, limit, extraWords = []) {
  const out = []
  let baseHost = ''
  try {
    baseHost = new URL(digest.url).hostname
  } catch (_) {
    return out
  }

  const matches = (text) =>
    LIST_WORD.test(text) || extraWords.some((w) => text.toLowerCase().includes(String(w).toLowerCase()))

  for (const item of digest.columns || []) {
    if (item.href === digest.url) continue
    try {
      if (baseHost && new URL(item.href).hostname !== baseHost) continue
    } catch (_) {
      continue
    }
    if (!matches(item.text)) continue
    // 只要栏目页，不要具体文章（文章地址一般很长或带 id）
    if (item.href.length - digest.url.length > 80) continue
    if (!out.includes(item.href)) out.push(item.href)
    if (out.length >= limit) break
  }
  return out
}

// ============================================================
// 站内检索
// ============================================================

/**
 * 找到站点的检索入口：命中 GET 表单就直接拼检索地址，只有裸输入框就标记出来模拟输入。
 * 很多平台首页的列表和主题无关，必须在站内搜一次才有相关数据。
 */
async function buildSearchRequest (page, keyword) {
  return await page
    .evaluate((kw) => {
      const hint = (el) =>
        [
          el.name,
          el.id,
          typeof el.className === 'string' ? el.className : '',
          el.placeholder,
          el.getAttribute('aria-label')
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()

      const isSearchish = (el) =>
        /search|keyword|query|关键词|关键字|搜索|检索|查询|\bkw\b|\bwd\b|\bq\b|\bkey\b|\bso\b/i.test(hint(el))
      const isVisible = (el) => {
        const r = el.getBoundingClientRect()
        const st = window.getComputedStyle(el)
        return r.width > 40 && r.height > 10 && st.display !== 'none' && st.visibility !== 'hidden'
      }

      const inputs = Array.from(
        document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')
      ).filter((el) => isVisible(el) && !el.disabled && !el.readOnly)

      // 1) GET 表单：直接拼出检索地址（最稳，不依赖点击和回车）
      for (const input of inputs) {
        if (!isSearchish(input)) continue
        const form = input.closest('form')
        if (!form) continue
        if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') continue
        const param = input.name || input.id
        if (!param) continue

        let url = ''
        try {
          url = new URL(form.getAttribute('action') || location.href, location.href).href
        } catch (_) {
          continue
        }
        const target = new URL(url)
        target.searchParams.set(param, kw)
        return { mode: 'url', url: target.href }
      }

      // 2) 裸输入框：标记它，交给 Playwright 模拟输入
      const target = inputs.find(isSearchish)
      if (target) {
        target.setAttribute('data-crawler-search-box', '1')

        // 顺手找一下旁边的搜索按钮（有些站点回车不生效，必须点按钮）
        let scope = target.parentElement
        for (let depth = 0; depth < 3 && scope; depth++) {
          const btn = Array.from(scope.querySelectorAll('button, [type="submit"], [type="button"], a, i, span')).find(
            (b) =>
              /^(搜索|查询|搜|检索|search)$/i.test((b.textContent || '').trim()) ||
              /search|query/i.test(typeof b.className === 'string' ? b.className : '')
          )
          if (btn) {
            btn.setAttribute('data-crawler-search-btn', '1')
            break
          }
          scope = scope.parentElement
        }
        return { mode: 'type' }
      }
      return null
    }, keyword)
    .catch(() => null)
}

/**
 * 在站点内检索关键词。
 * 返回 { url, digest }；有些站点检索后地址不变（结果原地刷新），
 * 所以这里直接取当前页摘要，而不是让调用方重新打开一次。
 */
async function searchWithinSite (session, siteUrl, keyword, onProgress) {
  const request = await buildSearchRequest(session.page, keyword)
  if (!request) {
    onProgress?.('这个站点没找到检索输入框')
    return null
  }

  if (request.mode === 'url') {
    onProgress?.(`用站内检索地址直接查：${request.url}`)
    await gotoWithRecovery(session, request.url, onProgress)
    await session.page.waitForTimeout(1500)

    // 有些站点的检索表单就指向首页（只是挂了个参数），打开后内容还是首页那一堆，
    // 这种地址不算检索结果页
    let path = ''
    try {
      path = new URL(session.page.url()).pathname.replace(/\/+$/, '')
    } catch (_) {
      path = ''
    }
    if (!path) {
      onProgress?.('这个检索地址打开后还是站点首页，检索没生效')
      return null
    }
  } else {
    const box = session.page.locator('[data-crawler-search-box="1"]').first()
    if (!(await box.isVisible().catch(() => false))) return null

    const before = session.page.url()
    onProgress?.(`在站内搜索框里输入：${keyword}`)
    await box.fill(keyword)
    await box.press('Enter')
    await session.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
    await session.page.waitForTimeout(1200)

    // 有些站点的搜索框必须点旁边的按钮才生效
    if (session.page.url() === before && (await session.page.locator('[data-crawler-search-btn="1"]').count().catch(() => 0))) {
      onProgress?.('回车没反应，改点搜索按钮')
      await session.page
        .locator('[data-crawler-search-btn="1"]')
        .first()
        .click({ timeout: 3000 })
        .catch(() => {})
      await session.page.waitForTimeout(1500)
    }
  }

  await autoScroll(session.page)
  const digest = await digestCurrent(session, listDigest)

  // 站点的搜索框可能是百度站内搜索（CSE）：输入关键词回车后直接跳到百度全网检索。
  // 那种结果不算这个站点的数据，收进来会把数据来源变成百度。
  if (!sameSite(session.page.url(), siteUrl)) {
    onProgress?.('搜索框把页面带到了站外（多半是百度站内搜索），不算这个站点的检索结果')
    return null
  }

  if (isBlockedPage(digest)) return { url: session.page.url(), digest, blocked: true }
  return { url: session.page.url(), digest }
}

/**
 * 有些站点（尤其是 JS 单页应用）首页没有搜索框，但页面里已经带着"检索地址"，
 * 比如 https://xxx/new/search.html?activeCataIndex=1&searchWords=
 * 这种地址把空参数填上关键词就能直接用，比模拟输入稳得多。
 *
 * 还有一种是页面上的"热门搜索"链接：//search.xxx.com/search?keywords=建筑
 * 它的参数名就是这个站点真正的检索参数，把值换成我们的关键词就能用
 * （bidcenter 就是这种：真正的检索在 search 子域上，光看首页搜索框是找不到的）。
 */
function buildSearchUrlsFromHints (digest, keyword) {
  const paramRe = /^(searchwords|searchword|keyword|keywords|kw|wd|q|query|keys|key|words?|searchtext|searchkey|title)$/i
  const out = []
  let baseHost = ''
  try {
    baseHost = new URL(digest.url).hostname
  } catch (_) {
    return out
  }

  // 参数值能不能被当成"可替换的检索词"：短、单行、不是数字 id、不是地址
  const replaceable = (value) =>
    value.length > 0 && value.length <= 30 && !/\s/.test(value) && !/^\d+$/.test(value) && !/^https?:/i.test(value)

  for (const link of digest.links || []) {
    let url
    try {
      url = new URL(link.href)
    } catch (_) {
      continue
    }
    if (url.hostname !== baseHost && !sameSite(url.href, digest.url)) continue
    if (!/(search|keyword|query|so\b|list|zbgg|gzgg|jyxx)/i.test(url.pathname + url.search)) continue

    let filled = false
    for (const [name, value] of Array.from(url.searchParams.entries())) {
      if (!paramRe.test(name)) continue
      if (String(value).trim() && !replaceable(String(value).trim())) continue // 有值但不是检索词，别乱改
      url.searchParams.set(name, keyword)
      filled = true
    }
    if (!filled) continue

    const href = url.href
    if (!out.includes(href)) out.push(href)
    if (out.length >= 3) break
  }
  return out
}

/** 只用摘要就能拼出检索地址：表单优先，其次是页面里已有的检索地址 */
function buildSearchUrls (digest, keyword) {
  const out = []

  const add = (href) => {
    if (!href) return
    try {
      const url = new URL(href)
      // 打开后还是站点首页的地址（只是挂了个参数）不算检索页，别浪费一次导航
      if (!url.pathname.replace(/\/+$/, '')) return
      if (!out.includes(url.href)) out.push(url.href)
    } catch (_) { /* 忽略非法地址 */ }
  }

  if (digest?.searchForm?.action && digest?.searchForm?.param) {
    // 站点的搜索框可能是百度站内搜索（CSE）这类站外服务，用它搜出来的是全网结果，
    // 不能当成这个站点的数据
    if (sameSite(digest.searchForm.action, digest.url)) {
      try {
        const url = new URL(digest.searchForm.action)
        url.searchParams.set(digest.searchForm.param, keyword)
        add(url.href)
      } catch (_) { /* 忽略非法地址 */ }
    }
  }

  for (const href of buildSearchUrlsFromHints(digest, keyword)) add(href)
  return out
}

/**
 * 依次尝试拼好的检索地址并取摘要。
 * 注意：不像平时那样"先看首页再检索"—— 有些站点（实测 dlzb）会因为这种连续请求弹滑块验证，
 * 直接打开检索地址反而不会触发。
 */
async function trySearchUrls (session, digest, keyword, onProgress) {
  const urls = buildSearchUrls(digest, keyword)

  for (const url of urls) {
    onProgress?.(`用站内检索地址直接查：${url}`)
    try {
      await gotoWithRecovery(session, url, onProgress)
      await session.page.waitForTimeout(1500)
      await autoScroll(session.page)
      const searched = await digestCurrent(session, listDigest)

      // 有些站点的"检索表单"其实就指向首页（只是多了个参数），
      // 打开后还是首页那一堆内容，不能当成检索结果页
      let path = ''
      try {
        path = new URL(session.page.url()).pathname.replace(/\/+$/, '')
      } catch (_) {
        path = ''
      }
      if (!path) {
        onProgress?.('这个地址打开后还是站点首页，不算检索结果页')
        continue
      }

      // 提交后跳到站外（例如百度 CSE 变成了百度全网检索）的结果不能算这个站点的数据
      if (!sameSite(session.page.url(), digest.url)) {
        onProgress?.('检索跳到了站外，不算这个站点的数据')
        continue
      }

      if (isBlockedPage(searched)) {
        onProgress?.('站点要求人机验证（滑块/验证码），这次先跳过')
        return { url: session.page.url(), digest: searched, blocked: true }
      }
      if (looksLikeList(searched)) return { url: session.page.url(), digest: searched }
    } catch (err) {
      onProgress?.(`检索地址打不开：${String(err.message || err).split('\n')[0]}`)
    }
  }
  return null
}

// 站内检索常见的关键词参数名。顺序 = 先试更常见的；
// 只靠这份名单是不够的（比如 chinabidding 用的是 searchWords），
// 所以 probeSearchUrl 会先从页面里把站点自己的参数名找出来，再补这些通用名。
const SEARCH_PARAM_NAMES = [
  'q',
  'kw',
  'wd',
  'keyword',
  'keywords',
  'searchWords',
  'searchWord',
  'searchword',
  'searchText',
  'searchKey',
  'searchContent',
  'keys',
  'key',
  'query',
  'word',
  'title',
  'text'
]

// 每个站点最多试几个参数名：猜参数每次都要开一次页面，不能无限试下去
const MAX_PARAM_PROBES = 8

/**
 * 两个地址是不是同一个站点（忽略 www. / m. 这类前缀，允许子域）。
 * 有些站点的搜索框其实是百度站内搜索（CSE），提交后跳到百度全网检索 ——
 * 那种结果不是"这个站点的数据"，混进来会把整站的数据来源变成百度，必须拦住。
 */
function sameSite (a, b) {
  const norm = (value) => {
    try {
      return new URL(value).hostname.toLowerCase().replace(/^(www|m|wap)\./, '')
    } catch (_) {
      return ''
    }
  }
  const ha = norm(a)
  const hb = norm(b)
  if (!ha || !hb) return false
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`)
}

/** 地址里是否真的带着这个关键词（在 query 参数里，或在路径里）—— 带着才可复现 */
function urlCarriesKeyword (url, keyword) {
  const kw = String(keyword || '')
  if (!kw) return false
  try {
    const u = new URL(url)
    for (const [, value] of u.searchParams.entries()) {
      if (value && value.includes(kw)) return true
    }
    return decodeURIComponent(u.pathname).includes(kw)
  } catch (_) {
    return false
  }
}

/**
 * 从当前页面里找出这个站点真实的检索参数名。
 * 依据：① 页面上"带了关键词的链接"（筛选/排序/翻页链接最容易暴露参数名）；
 * ② 当前地址自身的参数；③ 搜索输入框/下拉框的 name。
 * 这一步很关键：靠猜通用参数名（q、kw…）经常会漏掉站点真正用的名字，检索就整个失效。
 */
async function discoverSearchParams (page, keyword) {
  return await page
    .evaluate((kw) => {
      const out = []
      const push = (name) => {
        const n = String(name || '').trim()
        if (!n || n.length > 30 || out.includes(n)) return
        out.push(n)
      }

      for (const a of document.querySelectorAll('a[href]')) {
        let u
        try {
          u = new URL(a.href, location.href)
        } catch (_) {
          continue
        }
        if (u.hostname !== location.hostname) continue
        for (const [k, v] of u.searchParams.entries()) {
          if (v && v.includes(kw)) push(k)
        }
      }

      try {
        for (const [k, v] of new URL(location.href).searchParams.entries()) {
          if (v && v.includes(kw)) push(k)
        }
      } catch (_) { /* 忽略 */ }

      for (const el of document.querySelectorAll('input[name], input[id], select[name], textarea[name]')) {
        const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), typeof el.className === 'string' ? el.className : '']
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (/search|keyword|query|关键词|关键字|搜索|检索|查询|\bkw\b|\bwd\b|\bq\b|\bkey\b|\bword\b/.test(hint)) {
          push(el.name || el.id)
        }
      }

      return out.slice(0, 8)
    }, keyword)
    .catch(() => [])
}

/** 摘要里候选列表的条目链接，用来判断"换个地址后内容是不是真的变了" */
function itemHrefs (digest) {
  const set = new Set()
  for (const list of digest?.lists || []) {
    for (const link of (list.itemLinks || []).slice(0, 3)) {
      if (link?.href) set.add(link.href)
    }
  }
  return set
}

/** 地址里哪个参数装着这个关键词 —— 用来反推站点的检索参数名 */
function findKeywordParam (url, keyword) {
  const kw = String(keyword || '')
  if (!kw) return ''
  try {
    for (const [name, value] of new URL(url).searchParams.entries()) {
      if (value && value.includes(kw)) return name
    }
  } catch (_) { /* 忽略非法地址 */ }
  return ''
}

/**
 * 有些站点的检索结果只在会话里，地址上不带关键词（例如 s.zhaobiao.cn/s）。
 * 这种地址抓取时重新打开就是空的，所以必须换出一个"地址里带关键词、直接打开就有结果"的地址。
 *
 * 探测顺序很讲究：先用页面里发现的真实参数名（成功率高、还快），再补通用名。
 * 之前只用 q/kw/keyword/keywords 四个通用名硬猜，像 chinabidding 那种用
 * searchWords 的站点永远试不出来，最后只能抓入口页的"最新公告"，一条相关的都没有。
 */
async function probeSearchUrl (session, baseUrl, keyword, coreWords, onProgress, { sessionDigest = null, entryDigest = null } = {}) {
  let base
  try {
    base = new URL(baseUrl)
  } catch (_) {
    return null
  }

  // 地址上已经带着关键词 → 抓取时重新打开就是同一份结果，可以直接用
  if (urlCarriesKeyword(baseUrl, keyword)) {
    return { url: baseUrl, digest: null, param: findKeywordParam(baseUrl, keyword) }
  }

  const discovered = await discoverSearchParams(session.page, keyword)
  if (discovered.length) onProgress?.(`页面里发现这些检索参数名：${discovered.join('、')}`)

  const names = [...new Set([...discovered, ...SEARCH_PARAM_NAMES])].slice(0, MAX_PARAM_PROBES)
  const entryHrefs = itemHrefs(entryDigest)
  const sessionHrefs = itemHrefs(sessionDigest)

  for (const name of names) {
    const url = new URL(base.href)
    url.searchParams.set(name, keyword)
    try {
      onProgress?.(`试一下检索参数 ${name}=${keyword}`)
      await gotoWithRecovery(session, url.href, onProgress)
      await session.page.waitForTimeout(1200)
      await autoScroll(session.page)
      const digest = await digestCurrent(session, listDigest)

      // 参数被站点忽略时页面会把关键词丢掉
      if (!urlCarriesKeyword(session.page.url(), keyword)) continue

      // 更常见的情况是参数留在地址上、站点根本不认：此时页面和入口页一模一样
      // （bidcenter 的 ?aliSearchInput= 就是这样），必须拒掉，
      // 否则会把"最新公告列表"当成检索结果，抓回来一条相关的都没有。
      const hrefs = itemHrefs(digest)
      if (entryHrefs.size && ![...hrefs].some((h) => !entryHrefs.has(h))) {
        onProgress?.(`参数 ${name} 没有改变页面内容，说明站点不认这个参数`)
        continue
      }

      const sameAsSession = sessionHrefs.size && [...hrefs].some((h) => sessionHrefs.has(h))
      if (sameAsSession || (looksLikeList(digest) && (!coreWords.length || isTopicRelevant(digest, coreWords)))) {
        onProgress?.(`找到可复现的检索地址：${session.page.url()}`)
        return {
          url: session.page.url(),
          digest: sameAsSession ? sessionDigest : digest,
          // 参数名要带回去：抓取阶段靠它把同一个地址换成不同关键词批量搜
          param: name
        }
      }
    } catch (err) {
      onProgress?.(`参数 ${name} 试失败：${String(err.message || err).split('\n')[0]}`)
    }
  }

  onProgress?.('试不出可复现的站内检索地址，这个站点只能用列表页')
  return null
}

/** 站内检索用的核心词：站内搜索对长句往往搜不出东西，去掉"招标公告"这类通用词 */
function shortQuery (text) {
  const stop = /(项目|公告|公示|招标|投标|采购|询价|信息|结果|通知|消息|最新|查询|检索|平台|网站|数据)/g
  const stripped = String(text || '')
    .replace(stop, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length >= 2 ? stripped : ''
}

// ============================================================
// 搜索引擎发现
// ============================================================

// 依次尝试的搜索引擎（实测必应对中文长查询会切成单字，所以不用它）
const SEARCH_ENGINES = [
  {
    name: '百度',
    build: (kw) => `https://www.baidu.com/s?wd=${encodeURIComponent(kw)}`,
    itemSel: '#content_left h3 a, .result h3 a'
  },
  {
    name: '搜狗',
    build: (kw) => `https://www.sogou.com/web?query=${encodeURIComponent(kw)}`,
    itemSel: '.vrwrap h3 a, .results h3 a'
  },
  {
    name: '360',
    build: (kw) => `https://www.so.com/s?q=${encodeURIComponent(kw)}`,
    itemSel: '.res-list h3 a, #main h3 a'
  }
]

// 广告位、文库、问答百科之类的都不是我们要的公告页
const SEARCH_JUNK = /(\/baidu\.php\?|e\.so\.com\/search|\/search\/eclk|wenku\.|zhidao\.|baike\.|wenda\.|\.pdf$|\.docx?$|\.pptx?$)/i

/** 用搜索引擎找候选页面：先百度，拿不到再用搜狗/360 */
async function searchCandidates (session, keywords, topicKeywords, onProgress) {
  const found = []
  const seen = new Set()

  for (const keyword of keywords.slice(0, 3)) {
    let got = 0

    for (const engine of SEARCH_ENGINES) {
      if (got >= 5) break
      onProgress?.(`正在用${engine.name}搜索：${keyword}`)

      let items = []
      try {
        await gotoWithRecovery(session, engine.build(keyword), onProgress)
        await session.page.waitForTimeout(1200)
        items = await session.page.evaluate((sel) => {
          const out = []
          for (const a of document.querySelectorAll(sel)) {
            const text = String(a.textContent || '').replace(/\s+/g, ' ').trim()
            const href = a.href
            if (text && /^https?:/i.test(href)) out.push({ title: text.slice(0, 80), href })
          }
          return out
        }, engine.itemSel)
      } catch (err) {
        onProgress?.(`${engine.name}搜索失败：${err.message}`)
        continue
      }

      for (const item of items) {
        if (!item.href || SEARCH_JUNK.test(item.href)) continue
        // 结果标题/地址里要能看到公告类关键词，否则多半不是公告页
        if (!LIST_WORD.test(item.title) && !LIST_WORD.test(item.href)) continue
        // 必须和主题沾边：避免把"中国政府采购网"这类综合站点首页拉进来
        if (topicKeywords.length) {
          const text = `${item.title} ${item.href}`.toLowerCase()
          if (!topicKeywords.some((k) => text.includes(String(k).toLowerCase()))) continue
        }
        if (seen.has(item.href)) continue
        seen.add(item.href)
        found.push({ ...item, engine: engine.name })
        got += 1
        if (found.length >= 25 || got >= 5) break
      }
    }

    if (found.length >= 25) break
  }

  return found
}

// ============================================================
// 对外主函数
// ============================================================

/**
 * 站点调研：把候选页面逐个打开，抓出页面结构摘要，供 AI 生成精确选择器。
 * @param {{candidates:Array<{url:string,source?:string,title?:string}>, keywords?:string[], expand?:boolean, onProgress?:Function}} payload
 */
export async function analyzeSites ({
  candidates = [],
  keywords = [],
  topic = '',
  topicKeywords = [],
  expand = true,
  onProgress
}) {
  const report = (percent, message) => onProgress?.({ phase: 'analyze', percent, message })

  const maxSites = Number(config.MAX_SITES) || 6
  const coreWords = (Array.isArray(topicKeywords) ? topicKeywords : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
  // 站内检索用词：优先用搜索规划给的扩展关键词（取前几个，探测出检索模板就够用），
  // 再退回"去掉通用词的主题"和主题原句。找到可复现的检索地址后就跳出，不会白开页面。
  const searchQueries = []
  for (const q of [...keywords.slice(0, 3), shortQuery(topic), topic]) {
    const text = String(q || '').trim()
    if (text && !searchQueries.includes(text)) searchQueries.push(text)
  }
  const queues = []
  const seenUrl = new Set()

  for (const item of candidates) {
    const normalized = normalizeUrl(item?.url)
    if (!normalized || seenUrl.has(normalized)) continue
    seenUrl.add(normalized)
    queues.push({ url: normalized, source: item.source || '候选页面', title: item.title || '' })
  }

  const browser = await chromium.launch({
    headless: config.HEADLESS === true,
    channel: config.HEADLESS === true ? 'chromium' : undefined,
    args: ['--disable-blink-features=AutomationControlled']
  })
  const viewport = { width: 1440, height: 900 }

  async function newSession () {
    const ctx = await withTimeout(
      browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport }),
      10000,
      '创建新会话'
    )
    const nextPage = await withTimeout(ctx.newPage(), 10000, '创建新页面')
    nextPage.setDefaultTimeout(Number(config.PAGE_TIMEOUT) || 30000)
    return { ctx, page: nextPage }
  }

  let context = null
  let page = null
  {
    const fresh = await newSession()
    context = fresh.ctx
    page = fresh.page
  }

  /**
   * 换一个干净会话。
   * 注意：不能 await 关闭旧会话 —— 旧页面可能卡在未完成的导航上，
   * page.close()/context.close() 会一直等下去（这就是之前"卡住不动"的原因）。
   * 正确做法：先把新会话建好，旧的丢到后台去关。
   */
  async function renewSession () {
    const oldPage = page
    const oldContext = context

    const fresh = await newSession()
    context = fresh.ctx
    page = fresh.page

    const oldPageClosed = oldPage ? oldPage.close().catch(() => {}) : Promise.resolve()
    const oldContextClosed = oldContext ? oldContext.close().catch(() => {}) : Promise.resolve()
    Promise.all([oldPageClosed, oldContextClosed]).catch(() => {})
  }

  // 交给各步骤使用：page 会在会话重置后变，所以用取值器而不是传死引用
  const session = {
    get page () {
      return page
    },
    reset: renewSession
  }

  const sites = []
  const errors = []

  try {
    // 1) 搜索引擎补充候选页面（用户给的链接排在前面，优先分析）
    if (expand && keywords.length) {
      report(5, '正在用搜索引擎找相关页面…')
      const searched = await searchCandidates(session, keywords, coreWords, (m) => report(8, m))
      for (const item of searched) {
        if (seenUrl.has(item.href)) continue
        seenUrl.add(item.href)
        queues.push({ url: item.href, source: '搜索发现', title: item.title })
        if (queues.length >= maxSites) break
      }
      report(12, `搜索到 ${searched.length} 个候选页面`)
    }

    // 2) 逐个打开候选页面，取结构摘要
    for (let i = 0; i < queues.length && sites.length < maxSites; i++) {
      const item = queues[i]
      const percent = 12 + Math.round((i / Math.max(queues.length, 1)) * 68)
      report(percent, `[${i + 1}/${queues.length}] 正在分析页面结构：${item.url}`)

      try {
        let digest = await openDigest(session, item.url, listDigest, (m) => report(percent, m))

        // 入口页就是风控页的话，换个会话再来一次
        if (isBlockedPage(digest)) {
          report(percent, '入口页命中人机验证，换一个会话重试')
          await session.reset()
          digest = await openDigest(session, item.url, listDigest, (m) => report(percent, m))
          if (isBlockedPage(digest)) {
            errors.push(`${item.url} 要求人机验证（滑块/验证码），已跳过`)
            continue
          }
        }

        const site = {
          url: item.url,
          finalUrl: digest.url,
          source: item.source,
          title: digest.title || item.title || '',
          listDigest: digest,
          listPages: [],
          sampleDetail: null
        }

        // ★ 关键一步：先在站内用主题搜一次。
        // 平台首页展示的是"最新公告"，和主题无关，只有站内检索的结果才真正对得上。
        let searchPage = null
        for (let qi = 0; qi < searchQueries.length; qi++) {
          const query = searchQueries[qi]
          report(percent, `正在站内检索「${query}」：${item.url}`)

          try {
            let found = await trySearchUrls(session, digest, query, (m) => report(percent, m))

            // 命中人机验证：换个干净会话直接开检索地址（不先看首页，实测这样不容易触发）
            if (found?.blocked) {
              report(percent, '换个干净会话重试站内检索')
              await session.reset()
              found = await trySearchUrls(session, digest, query, (m) => report(percent, m))
            }

            // 拼不出检索地址时，退回"在页面里模拟输入"
            if (!found) {
              found = await searchWithinSite(session, item.url, query, (m) => report(percent, m))
            }

            if (found?.blocked) {
              report(percent, '站点坚持要求人机验证，本站点只用入口页列表')
              break
            }

            if (found && looksLikeList(found.digest)) {
              // 检索结果的地址必须"可复现"（地址里带关键词），否则抓取时重新打开是空的
              const reproducible = await probeSearchUrl(
                session,
                found.url,
                query,
                coreWords,
                (m) => report(percent, m),
                { sessionDigest: found.digest, entryDigest: digest }
              )

              if (reproducible) {
                const searchDigest = reproducible.digest || found.digest
                const param = reproducible.param || findKeywordParam(reproducible.url, query)
                searchPage = { ...searchDigest, url: reproducible.url, param, kind: '站内检索结果页' }
                report(
                  percent,
                  `站内检索命中列表：${searchDigest.lists[0].count} 条，地址 ${reproducible.url}（关键词参数 ${
                    param || '未知'
                  }）`
                )
              } else {
                report(percent, '检索结果只在会话里、地址不可复现，抓取时用不上，改用入口页')
              }
              break
            }

            report(
              percent,
              `「${query}」没搜出结果列表（页面 ${found?.digest?.url || '未跳转'}，链接 ${
                found?.digest?.links?.length || 0
              } 个，候选块 ${found?.digest?.lists?.length || 0} 个）`
            )
          } catch (err) {
            errors.push(`站内检索失败（${item.url}）：${err.message}`)
          }
        }

        // 组装可抓取的列表页。
        // 入口列表跟主题无关时不能直接放弃整站 —— 站内往往有"风电招标"这类更贴题的栏目页
        let listPages = []
        if (searchPage) listPages.push(searchPage)

        const entryIsList = looksLikeList(digest)
        const entryRelevant = !coreWords.length || isTopicRelevant(digest, coreWords)

        if (entryIsList && entryRelevant) {
          listPages.push({ ...digest, kind: '入口页' })
        } else {
          report(
            percent,
            entryIsList ? '入口页列表与主题无关，去站内找更贴题的栏目' : '入口页不像列表，去站内找栏目页'
          )

          let attempts = 0
          let foundColumns = 0
          for (const column of pickColumnLinks(digest, 6, coreWords)) {
            if (foundColumns >= 2 || attempts >= 4) break
            attempts += 1
            try {
              report(percent, `正在分析栏目页：${column}`)
              const columnDigest = await openDigest(session, column, listDigest, (m) => report(percent, m))
              if (!looksLikeList(columnDigest)) continue
              if (coreWords.length && !isTopicRelevant(columnDigest, coreWords)) {
                report(percent, `栏目页与主题无关，跳过：${column}`)
                continue
              }
              listPages.push({ ...columnDigest, kind: '栏目页' })
              foundColumns += 1
            } catch (err) {
              errors.push(`${column} 打开失败：${String(err.message || err).split('\n')[0]}`)
            }
          }

          // 实在找不到贴题栏目，且入口本身是列表，就先留着让后续流程判断
          if (!listPages.length && entryIsList) listPages.push({ ...digest, kind: '入口页' })
          if (!listPages.length && !entryIsList) listPages.push({ ...digest, kind: '入口页（未识别出列表结构）' })
        }

        // 站点内容跑偏就整站放弃 —— 比如搜"风电招标"却只拉到"政府采购政策新闻"栏目，
        // 这种站点抓下来全是无关数据，宁可不抓
        if (coreWords.length) {
          const relevant = listPages.filter((d) => isTopicRelevant(d, coreWords))
          if (relevant.length !== listPages.length) {
            report(percent, `该站点有 ${listPages.length - relevant.length} 个列表页与主题无关，已忽略`)
          }
          if (!relevant.length) {
            errors.push(`${item.url} 的列表内容与主题无关，已跳过`)
            continue
          }
          listPages = relevant
        }

        site.listPages = listPages.map((d) => ({
          url: d.url,
          title: d.title,
          kind: d.kind || '',
          // 先帮 AI 验证一遍：哪个候选选择器选出来的条目真的和主题相关
          lists: (d.lists || []).map((l) => ({
            ...l,
            relevant: listCandidateRelevant(l, coreWords)
          })),
          linkSamples: (d.links || []).slice(0, 30).map((l) => l.text),
          text: d.text
        }))

        // 站内检索地址模板：留着"地址 + 关键词参数名"，抓取阶段就能把同一个地址
        // 换成不同关键词各搜一次（多关键词批量搜索靠它）
        const keptSearchPage = listPages.find((d) => d.kind === '站内检索结果页' && d.param)
        site.searchTemplate = keptSearchPage
          ? { url: keptSearchPage.url, param: keptSearchPage.param }
          : null
        if (site.searchTemplate) {
          report(percent, `该站可按关键词批量搜：参数 ${site.searchTemplate.param}`)
        }

        // 3) 挑一条详情页做样本，让 AI 能定字段选择器
        const detailUrl = pickDetailLink(listPages[0] || digest)
        if (detailUrl) {
          try {
            report(percent, `正在分析详情页样本：${detailUrl}`)
            const detail = await openDigest(session, detailUrl, detailDigest, (m) => report(percent, m))
            site.sampleDetail = {
              url: detail.url,
              title: detail.title,
              titleSelector: detail.titleSelector,
              dates: detail.dates,
              blocks: detail.blocks,
              text: detail.text
            }
          } catch (err) {
            errors.push(`详情页样本 ${detailUrl} 打开失败：${String(err.message || err).split('\n')[0]}`)
          }
        }

        sites.push(site)
      } catch (err) {
        errors.push(`${item.url} 打开失败：${String(err.message || err).split('\n')[0]}`)
        report(percent, `${item.url} 打不开，已跳过`)
      }
    }
  } finally {
    await withTimeout(Promise.resolve(context?.close()).catch(() => {}), 5000, '关闭会话').catch(() => {})
    await withTimeout(browser.close().catch(() => {}), 5000, '关闭浏览器').catch(() => {})
  }

  report(80, `页面结构分析完成：可用站点 ${sites.length} 个`)

  return {
    sites,
    errors,
    topicKeywords: coreWords,
    pending: queues.filter((q) => !sites.some((s) => s.url === q.url)).map((q) => ({ url: q.url, source: q.source }))
  }
}
