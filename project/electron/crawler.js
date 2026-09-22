import pw from 'playwright'
import * as cheerio from 'cheerio'
import axios from 'axios'
import config from '../config.js'

const { chromium } = pw

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 正文兜底选择器：当 AI 给的选择器全部取不到内容时使用
const CONTENT_SELECTORS = [
  'article',
  '.article-content',
  '.article_content',
  '.article',
  '.content',
  '#content',
  '#Content',
  '.TRS_Editor',
  '.detail-content',
  '.detail_content',
  '.news_content',
  '.v_news_content',
  '.artical',
  '.box-content',
  '.cont',
  'main'
]

const LINK_FIELD = /(链接|网址|链接地址|url|link|href)/i
const CONTENT_FIELD = /(内容|正文|详情|描述|摘要|公告|附件)/

let stopRequested = false

/**
 * 给任意 Promise 加超时。
 * 浏览器相关调用（close / evaluate）在页面卡住时会一直不返回，必须自己兜底，
 * 否则整个抓取就"卡住不动"了。
 */
function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}秒）`)), ms))
  ])
}

/** 请求终止抓取（下一次循环时生效） */
export function requestStop () {
  stopRequested = true
}

// ============ 文本工具 ============

function clean (value) {
  return String(value == null ? '' : value)
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate (value, max) {
  const s = clean(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function absolute (href, baseUrl) {
  if (!href) return ''
  const h = String(href).trim()
  if (!h || h.startsWith('#') || /^javascript:/i.test(h)) return ''
  try {
    return new URL(h, baseUrl).href
  } catch (_) {
    return ''
  }
}

function hostOf (url) {
  try {
    return new URL(url).hostname
  } catch (_) {
    return ''
  }
}

// ============ 页面解析 ============

function getMainText ($) {
  const $clone = $.root().clone()
  $clone.find('script, style, noscript, iframe, nav, footer, header, aside, .nav, .footer, .header').remove()

  for (const sel of CONTENT_SELECTORS) {
    const text = clean($clone.find(sel).first().text())
    if (text.length > 50) return text.slice(0, 6000)
  }
  return clean($clone.find('body').text()).slice(0, 6000)
}

/**
 * 取一个字段的值
 * @param {*} $ cheerio 实例
 * @param {*} $scope 相对作用域（整页或某个列表项）
 * @param {*} spec AI 给出的选择器（字符串 / {selector, attr}）
 */
function pickValue ($, $scope, spec, pageUrl, fieldName, allowContentFallback = true) {
  if (spec && typeof spec === 'object') {
    const sel = String(spec.selector || spec.path || '').trim()
    const $el = sel ? $scope.find(sel).first() : $()
    if (!$el.length) return spec.default ? String(spec.default) : ''
    if (spec.attr) return absolute($el.attr(String(spec.attr)), pageUrl) || clean($el.attr(String(spec.attr)))
    return clean($el.text())
  }

  const raw = String(spec || '').trim()
  if (!raw) return ''

  // 1) 当作 CSS 选择器
  if ($scope && typeof $scope.find === 'function') {
    try {
      const $el = $scope.find(raw).first()
      if ($el.length) {
        if (LINK_FIELD.test(fieldName)) {
          const href = $el.attr('href') || $el.find('a').first().attr('href')
          if (href) return absolute(href, pageUrl)
        }
        const text = clean($el.text())
        if (text) return text
        const href = $el.attr('href') || $el.find('a').first().attr('href')
        if (href) return absolute(href, pageUrl)
      }
    } catch (_) { /* 非法选择器忽略 */ }
  }

  // 2) 当作字面量文本
  if (!/[#.[\]>:]/.test(raw) && /[\u4e00-\u9fa5]/.test(raw)) return raw

  // 3) 内容型字段兜底为整页正文
  if (allowContentFallback && CONTENT_FIELD.test(fieldName)) {
    const text = getMainText($)
    if (text) return text.slice(0, 3000)
  }
  return ''
}

/**
 * 按字段配置取值（不做兜底）
 * @param {boolean} allowContentFallback 是否允许"内容型字段取整页正文"的兜底
 */
function pickFields ($, $scope, fields, pageUrl, allowContentFallback = true) {
  let specs = fields && typeof fields === 'object' ? fields : {}
  if (!Object.keys(specs).length) specs = { 标题: 'h1', 内容: 'article' }

  const values = {}
  let filled = 0
  for (const [name, spec] of Object.entries(specs)) {
    const value = pickValue($, $scope, spec, pageUrl, name, allowContentFallback)
    if (value) filled += 1
    values[name] = value
  }
  return { values, filled, specs }
}

/** 选择器全部失效时，用标题 + 正文兜底，交给 AI 后续清洗 */
function fallbackFill ($, values, specs) {
  const title = clean($('title').text())
  const text = getMainText($)
  for (const name of Object.keys(specs)) {
    if (values[name]) continue
    if (CONTENT_FIELD.test(name)) values[name] = text.slice(0, 2000)
    else if (title) values[name] = title
  }
  return values
}

/**
 * 从当前页面/列表项抽取一行数据
 */
function extractRow ($, $scope, fields, pageUrl) {
  const { values, filled, specs } = pickFields($, $scope, fields, pageUrl)
  if (filled === 0) fallbackFill($, values, specs)
  values.__source = pageUrl
  return values
}

/**
 * 收集列表页中的详情链接。
 * 顺便把"列表行自带字段"的值一起抽出来当兜底 —— 很多站点的日期、标题只在列表行上，
 * 跟进详情页后如果详情页没有这些字段，就用列表行的值补上。
 */
function collectItems ($, selector, baseUrl, listFields) {
  const out = []
  const seen = new Set()
  try {
    $(selector).each((_, el) => {
      const $el = $(el)
      const $a = $el.is('a') ? $el : $el.find('a').first()
      if (!$a.length) return
      const href = absolute($a.attr('href'), baseUrl)
      if (!href || !/^https?:/i.test(href)) return
      if (seen.has(href)) return
      seen.add(href)

      let values = null
      if (listFields && Object.keys(listFields).length) {
        // 列表行里不许做"内容字段取整页正文"的兜底，否则每行都会被塞进整页文本
        values = pickFields($, $el, listFields, baseUrl, false).values
      }
      out.push({ href, values })
    })
  } catch (_) { /* 选择器非法 */ }
  return out
}

// ============ 页面加载 ============

/** Axios 兜底：浏览器打不开时直接抓静态 HTML */
async function fetchStatic (url) {
  const res = await axios.get(url, {
    timeout: Number(config.PAGE_TIMEOUT) || 30000,
    responseType: 'text',
    maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
  })
  return String(res.data || '')
}

/** 用户填写的链接可能不带协议，统一补全 */
export function normalizeUrl (value) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return `https:${s}`
  return `https://${s}`
}

/** 密码本匹配：按域名匹配账号（密码本里的 site 可以是 example.com / www.example.com / https://example.com/login） */
function matchCredential (passwordBook, pageUrl) {
  const sites = passwordBook?.sites || []
  if (!Array.isArray(sites) || !sites.length) return null

  const host = hostOf(pageUrl).toLowerCase().replace(/^www\./, '')
  if (!host) return null

  return (
    sites.find((s) => {
      const site = String(s?.site || s?.match || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .replace(/^www\./i, '')
        .toLowerCase()
      if (!site) return false
      return host === site || host.endsWith(`.${site}`) || host.includes(site)
    }) || null
  )
}

/** 当前可见的密码框是不是来自"注册"表单（不少站点默认弹注册，要点一下"登录"标签） */
async function isRegisterForm (page) {
  return await page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const st = window.getComputedStyle(el)
        return r.width > 20 && r.height > 5 && st.display !== 'none' && st.visibility !== 'hidden'
      }
      const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find(visible)
      if (!pwd) return false

      const scope =
        pwd.closest('form') ||
        pwd.closest('[class*="dialog" i], [class*="modal" i], [class*="login" i], [class*="auth" i], [class*="register" i]')
      if (!scope) return false

      // 表单提交地址就写着注册
      if (/register|signup|regist/i.test(scope.getAttribute('action') || '')) return true

      // 有"确认密码"这种第二个密码框 → 注册
      if (scope.querySelectorAll('input[type="password"]').length >= 2) return true

      // 提交按钮写着"注册"，而且没有任何按钮写着"登录"
      const buttons = Array.from(
        scope.querySelectorAll('button, input[type="submit"], [type="button"], a[class*="btn" i], .btn, .submit')
      )
      const text = buttons.map((b) => (b.textContent || b.value || '').trim()).join(' ')
      return /注册|register|sign\s?up/i.test(text) && !/登录|login|sign\s?in/i.test(text)
    })
    .catch(() => false)
}

/** 默认展示注册表单时，先切到"登录"标签 */
async function switchToLoginTab (page, onProgress) {
  const entries = page.locator('a, button, span, div, li, p').filter({
    hasText: /^\s*(登录|立即登录|账号登录|登录账号|我要登录|用户登录|会员登录|登录\/注册|登录或注册)\s*$/
  })

  const count = await entries.count().catch(() => 0)
  for (let i = 0; i < Math.min(count, 8); i++) {
    const el = entries.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    const text = (await el.innerText().catch(() => '')).trim()
    if (/注册|register/i.test(text)) continue
    await el.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(900)
    onProgress?.(`当前是注册表单，已点击「${text}」切换`)
    return true
  }
  return false
}

/** 页面上有没有"可见的"密码框 */
async function hasVisiblePassword (page) {
  const count = await page.locator('input[type="password"]:visible').count().catch(() => 0)
  return count > 0
}

/**
 * 点开站点的登录入口。
 * 很多平台的登录不是独立页面，而是点导航栏里的"登录"弹出的弹窗 ——
 * 页面上根本没有密码框，不点开就永远是游客状态
 * （这就是"密码本给了账号，抓回来却是未登录数据"的原因）。
 */
async function openLoginForm (page, onProgress) {
  const entries = page.locator('a, button, span, div, li, p').filter({
    hasText: /^\s*(登录|登\s*录|立即登录|马上登录|用户登录|会员登录|账号登录|请登录|登录\/注册|登录或注册|登录\/注\s*册)\s*$/
  })

  const count = await entries.count().catch(() => 0)
  for (let i = 0; i < Math.min(count, 10); i++) {
    const el = entries.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    const text = (await el.innerText().catch(() => '')).trim()
    if (/注册/.test(text) && !/登录/.test(text)) continue // 纯注册入口不要点

    await el.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1200)
    if (await hasVisiblePassword(page)) {
      onProgress?.(`已点开登录入口「${text}」`)
      return true
    }
  }
  return false
}

/**
 * 在可见的登录表单里定位账号框、密码框、提交按钮并打标记。
 * 只认"可见"的元素 —— 很多站点同时把注册表单放在 DOM 里，
 * 直接取第一个 input[type=password] 会拿到被隐藏的注册密码框。
 */
async function locateLoginFields (page) {
  return await page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const st = window.getComputedStyle(el)
        return r.width > 20 && r.height > 5 && st.display !== 'none' && st.visibility !== 'hidden'
      }

      const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find(visible)
      if (!pwd) return null
      pwd.setAttribute('data-crawler-pwd', '1')

      const scope = pwd.closest('form') || pwd.parentElement?.parentElement || pwd.parentElement || document

      const textInputs = Array.from(
        scope.querySelectorAll('input[type="text"], input[type="tel"], input[type="email"], input:not([type])')
      ).filter((el) => visible(el) && el !== pwd && !el.readOnly && !el.disabled)

      const user =
        textInputs.find((el) =>
          /user|account|name|mobile|phone|tel|mail|账号|用户|手机/i.test(
            [el.name, el.id, el.placeholder].filter(Boolean).join(' ')
          )
        ) || textInputs[0]
      if (user) user.setAttribute('data-crawler-user', '1')

      const buttons = Array.from(
        scope.querySelectorAll('button, input[type="submit"], [type="button"], .btn, .login-btn, .submit')
      ).filter(visible)

      const submit =
        buttons.find((b) => /^\s*(登录|登\s*录|立即登录|提交|确定)\s*$/.test((b.textContent || b.value || '').trim())) ||
        buttons.find((b) => /登录|login|sign\s?in/i.test(b.textContent || b.value || '')) ||
        buttons.find((b) => (b.getAttribute('type') || '').toLowerCase() === 'submit') ||
        buttons[0]
      if (submit) submit.setAttribute('data-crawler-submit', '1')

      return { hasUser: !!user, hasSubmit: !!submit }
    })
    .catch(() => null)
}

/** 遇到需要登录的站点时，自动填充密码本里的账号密码 */
async function handleLogin (page, passwordBook, onProgress, attempted) {
  const site = matchCredential(passwordBook, page.url())
  const loginUrl = site?.loginUrl
  if (loginUrl && page.url() !== loginUrl) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }

  const host = hostOf(page.url())
  const formVisible = await hasVisiblePassword(page)

  if (!site) {
    if (formVisible) onProgress?.(`检测到登录页（${host}），但密码本中没有匹配的账号，跳过自动登录`)
    return false
  }

  // 同一个站点一次运行里只尝试一次，避免每个详情页都去提交一遍登录
  if (attempted?.has(host)) return false

  // 页面上没有密码框时，先去点开登录入口（导航里的"登录"、弹窗、登录页链接），
  // 否则平台的列表页/检索页永远停在游客状态，密码本等于没用上
  let openedByUs = false
  if (!formVisible) {
    openedByUs = await openLoginForm(page, onProgress)
    if (!openedByUs) return false
  }

  attempted?.add(host)

  // 默认弹的是注册表单时，先切到登录表单
  if (await isRegisterForm(page)) {
    onProgress?.(`${host} 默认显示的是注册表单，正在切换到登录…`)
    await switchToLoginTab(page, onProgress)
    if (!(await hasVisiblePassword(page))) return false
  }

  // 点开登录入口后地址可能变了，重新匹配一次账号
  const matched = matchCredential(passwordBook, page.url()) || site

  // 定位到当前可见表单里的账号框 / 密码框 / 提交按钮
  const fields = await locateLoginFields(page)
  if (!fields) {
    onProgress?.('没找到可见的登录表单，跳过自动登录')
    return false
  }

  const userSel = matched.usernameSelector || '[data-crawler-user="1"]'
  const pwdSel = matched.passwordSelector || '[data-crawler-pwd="1"]'
  const submitSel = matched.submitSelector || '[data-crawler-submit="1"]'

  onProgress?.(`检测到登录入口，正在使用密码本中的 ${matched.username} 自动登录…`)

  try {
    if (fields.hasUser) {
      await page.locator(userSel).first().fill(String(matched.username || ''))
    }
    await page.locator(pwdSel).first().fill(String(matched.password || ''))

    if (fields.hasSubmit) {
      await page
        .locator(submitSel)
        .first()
        .click({ timeout: 8000 })
        .catch(() => page.locator(pwdSel).first().press('Enter'))
    } else {
      await page.locator(pwdSel).first().press('Enter')
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1500)

    // 登录成功的判据：登录框消失了（提交后还留着登录框，多半是账号密码不对或有验证码）
    const stillLogin = await hasVisiblePassword(page)
    if (stillLogin) {
      onProgress?.(`自动登录已提交，但登录框还在（账号密码不对 / 需要验证码），${host} 这次按未登录抓`)
    } else {
      onProgress?.(`已登录 ${host}（账号 ${matched.username}）`)
    }

    // 登录弹窗还盖在页面上会影响后面解析内容，按 Esc 关掉
    if (openedByUs) {
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)
    }
    return !stillLogin
  } catch (err) {
    onProgress?.(`自动登录失败：${err.message}`)
    return false
  }
}

/** 轻量滚动，触发懒加载内容 */
export async function autoScroll (page) {
  await withTimeout(
    page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0
        const tick = () => {
          y += Math.round(window.innerHeight * 0.8)
          window.scrollTo(0, y)
          if (y < document.body.scrollHeight && y < 12000) setTimeout(tick, 220)
          else {
            window.scrollTo(0, 0)
            setTimeout(resolve, 220)
          }
        }
        tick()
      })
    }),
    20000,
    '滚动页面'
  ).catch(() => {})
}

/** https <-> http 互换，用于打不开时自动重试（很多老站点只有 http） */
export function swapProtocol (url) {
  if (/^https:\/\//i.test(url)) return url.replace(/^https:/i, 'http:')
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, 'https:')
  return ''
}

/**
 * 页面还停在"加载中 / 暂无数据"这种中间态。
 * 正文其实已经有了（导航、筛选条），但真正的列表是 XHR 异步渲染的，要等几秒才出来，
 * 中途站点还会先显示"暂无数据，换个关键词试试"当占位。
 * 只看"正文长度"会把这种中间态当成最终结果，于是得出"这个站点没有数据"，整站被跳过。
 */
const PENDING_HINT = /(暂无数据|暂无内容|暂无记录|没有找到|未找到|加载中|正在加载|正在查询|请稍候)/

export function isPendingText (text) {
  return PENDING_HINT.test(String(text || ''))
}

/**
 * 等页面正文真正出现。
 * 用 waitUntil:'commit' 打开页面时，只是"服务器开始响应"，
 * 正文可能还没渲染出来；这里等到有内容再解析，避免把慢站点误判成没有数据。
 */
export async function waitForBody (page, timeout = 12000, minLength = 300) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await page
      .evaluate((source) => {
        const text = document.body ? document.body.innerText : ''
        return { length: text.length, pending: new RegExp(source, 'i').test(text) }
      }, PENDING_HINT.source)
      .catch(() => null)
    if (!state) return false // 页面已经不可用
    if (state.length >= minLength && !state.pending) return true
    await page.waitForTimeout(500)
  }
  return false
}

/**
 * 等列表条目真的渲染出来。
 * 有些把列表交给 JS 渲染的站点，外壳（导航、筛选条）先出现，条目要好几秒后才出来，
 * 所以不能只等"页面有文字"，要等选择器真的命中条目。
 */
export async function waitForListItems (page, selector, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector).catch(() => -1)
    if (count > 0) return true
    if (count < 0) return false // 选择器非法，再等也没用
    await page.waitForTimeout(600)
  }
  return false
}

async function loadInBrowser (session, url, passwordBook, onProgress) {
  const page = session.page
  const timeout = Number(config.PAGE_TIMEOUT) || 45000

  // 用 commit：只要服务器开始响应就算导航成功，
  // 慢站点的图片/脚本不会把导航卡死（正文由下面的 waitForBody 负责等）
  await page.goto(url, { waitUntil: 'commit', timeout })
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
  await waitForBody(page, 12000)

  await handleLogin(page, passwordBook, onProgress, session.loginAttempted)
  await autoScroll(page)

  // 页面卡住时 content() 也会一直不返回，必须兜底
  const html = await withTimeout(page.content(), 20000, '读取页面内容')
  const title = await withTimeout(page.title(), 8000, '读取标题').catch(() => '')
  return { html, url: page.url(), title: clean(title) }
}

/**
 * 先访问一次站点首页把会话"捂热"。
 * 很多平台（bidcenter 就是这样）直接打开深链接/检索地址会被人机验证拦住，
 * 而先看过一次首页、带上 cookie 之后再打开同一个地址就是正常结果。
 */
async function warmUp (session, url, passwordBook, onProgress) {
  let root = ''
  let host = ''
  try {
    const u = new URL(url)
    host = u.hostname
    root = `${u.protocol}//${host}/`
  } catch (_) {
    return
  }
  if (!host || session.warmed.has(host) || isSameUrl(root, url)) return
  session.warmed.add(host)

  try {
    onProgress?.(`先访问一次站点首页再抓，避免被人机验证拦住：${root}`)
    await loadInBrowser(session, root, passwordBook, onProgress)
  } catch (_) {
    // 首页打不开不影响后面按正常流程抓
  }
}

/** 两个地址是不是同一个页面（忽略 query/hash 与末尾斜杠） */
function isSameUrl (a, b) {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.hostname === ub.hostname && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
  } catch (_) {
    return a === b
  }
}

/**
 * 打开一个页面，返回渲染后的 HTML。
 * 失败时会先换一个干净页面再重试（失败后浏览器停在 chrome-error 页，
 * 直接在原页面上继续跳转会被它打断）。
 */
async function openPage (session, url, passwordBook, onProgress) {
  await warmUp(session, url, passwordBook, onProgress)

  try {
    return await loadInBrowser(session, url, passwordBook, onProgress)
  } catch (err) {
    await session.reset()

    // 换协议再试一次：用户没写 http:// 时我们会补 https，遇到只有 http 的站点就能救回来
    const alt = swapProtocol(url)
    if (alt) {
      try {
        onProgress?.(`${url} 打不开，换 ${alt.split(':')[0]} 重试`)
        return await loadInBrowser(session, alt, passwordBook, onProgress)
      } catch (_) {
        await session.reset()
      }
    }

    // 浏览器失败 → Axios + Cheerio 兜底
    onProgress?.(`浏览器打开失败，改用 Axios 直连：${url}`)
    const html = await fetchStatic(url)
    return { html, url, title: '', fallback: true }
  }
}

// ============ 主流程 ============

/**
 * 按计划执行抓取
 * @param {{plan:object, passwordBook:object, fields:string[], onProgress:Function}} payload
 */
export async function runCrawl ({ plan, passwordBook, fields, topicKeywords, rules, dateRange, onProgress }) {
  stopRequested = false

  const keywords = (Array.isArray(topicKeywords) ? topicKeywords : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)

  const tasks = (plan?.tasks || [])
    .filter((t) => t && t.url)
    .map((t) => ({ ...t, url: normalizeUrl(t.url) }))
  if (!tasks.length) throw new Error('爬取计划中没有可用的任务')

  const allFields = Array.isArray(fields) && fields.length ? fields : collectFields(tasks)
  const rows = []
  const pages = []
  const visited = new Set()

  // 页面预算要「按任务平分」：全局预算被第一个任务吃光的话，
  // 后面所有站点一条都抓不到（曾经就是这个原因导致结果只来自一个网站）
  const maxPages = Number(config.MAX_PAGES) || 50
  const minPerTask = Number(config.MIN_PAGES_PER_TASK) || 10
  const perTaskPages = Math.max(minPerTask, Math.floor(maxPages / tasks.length))
  const budget = { left: maxPages }

  const taskResults = []

  const report = (percent, message) => onProgress?.({ phase: 'crawl', percent, message })

  report(0, `准备启动浏览器（headless: ${config.HEADLESS === true}）`)
  report(0, `${tasks.length} 个任务，每个任务最多打开 ${perTaskPages} 个页面（总计上限 ${maxPages}）`)

  const browser = await chromium.launch({
    headless: config.HEADLESS === true,
    // 打包时只内置完整版 Chromium（不含 headless shell），
    // 因此无头模式也显式指定用完整版，避免运行时找不到内核
    channel: config.HEADLESS === true ? 'chromium' : undefined,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
  })
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    // 后台运行时没有真实窗口，必须显式给一个视口
    viewport: config.HEADLESS === true ? { width: 1440, height: 900 } : null
  })
  const session = createSession(context)
  await session.reset()

  // 记录抓取过程中的拦截情况
  const crawlStats = { blockedPages: 0 }

  try {
    for (let i = 0; i < tasks.length; i++) {
      if (stopRequested) break
      const task = tasks[i]
      const kw = task.keyword ? `关键词「${task.keyword}」 ` : ''
      report(
        Math.round((i / tasks.length) * 100),
        `[${i + 1}/${tasks.length}] ${kw}正在打开 ${task.url}（已抓到 ${rows.length} 条）`
      )

      try {
        const before = rows.length
        const detail = await crawlTask({
          session,
          task,
          passwordBook,
          rows,
          pages,
          budget,
          taskBudget: { left: perTaskPages },
          visited,
          crawlStats,
          report,
          taskIndex: i,
          taskTotal: tasks.length
        })
        taskResults.push({
          url: task.url,
          keyword: task.keyword || '',
          rows: rows.length - before,
          listPages: detail?.listPages || 0,
          items: detail?.items || 0
        })
      } catch (err) {
        report(Math.round((i / tasks.length) * 100), `任务失败：${task.url}（${err.message}）`)
        taskResults.push({ url: task.url, keyword: task.keyword || '', rows: 0, error: err.message })
      }
    }
  } finally {
    // 页面卡住时这两个 close 可能一直不返回，加超时兜底
    await withTimeout(Promise.resolve(context.close()).catch(() => {}), 5000, '关闭会话').catch(() => {})
    await withTimeout(browser.close().catch(() => {}), 5000, '关闭浏览器').catch(() => {})
  }

  const cleaned = normalizeRows(rows, allFields)
  const blocked = cleaned.filter((r) => isBlockedText(allFields.map((f) => r[f]).join(' '))).length
  const filtered = filterRows(cleaned, allFields, keywords, rules, dateRange)

  if (filtered.dateRule) {
    report(100, `按时间范围过滤：${filtered.dateRule.label}`)
  }
  if (filtered.droppedBlocked || blocked) {
    report(100, `已丢弃 ${Math.max(filtered.droppedBlocked, blocked)} 条风控/验证码页面的无效数据`)
  }
  if (filtered.droppedIrrelevant) {
    report(100, `已丢弃 ${filtered.droppedIrrelevant} 条与主题无关的记录`)
  }
  if (filtered.droppedByDate) {
    report(100, `已丢弃 ${filtered.droppedByDate} 条不符合时间要求的记录`)
  }
  if (filtered.droppedJunk) {
    report(100, `已丢弃 ${filtered.droppedJunk} 条导航/无效条目`)
  }
  if (filtered.undated) {
    report(100, `其中 ${filtered.undated} 条没有日期，无法判断时间范围，已保留`)
  }

  // 多关键词会搜出同一条公告，按"标题 + 发布日期"去重，只留一条
  const deduped = dedupeRows(filtered.kept, allFields)
  if (deduped.dropped) {
    report(100, `已按「标题 + 发布日期」去掉 ${deduped.dropped} 条重复记录`)
  }
  report(100, `抓取结束，共得到 ${deduped.kept.length} 条相关记录`)

  // 搜索日志：每个关键词的产出都报出来，方便看出哪个词有效、哪个词没搜到
  if (taskResults.length) {
    const byKeyword = new Map()
    for (const t of taskResults) {
      if (!t.keyword) continue
      const item = byKeyword.get(t.keyword) || { rows: 0, pages: 0, tasks: 0, error: '' }
      item.rows += t.rows
      item.pages += t.listPages || 0
      item.tasks += 1
      if (t.error) item.error = t.error
      byKeyword.set(t.keyword, item)
    }
    if (byKeyword.size) {
      report(
        100,
        `关键词命中：${[...byKeyword.entries()]
          .map(([kw, it]) => `${kw}=${it.rows}条/${it.pages}页`)
          .join('、')}`
      )
      const missed = [...byKeyword.entries()].filter(([, it]) => !it.rows)
      if (missed.length) {
        report(100, `这些关键词一条都没搜到：${missed.map(([kw]) => kw).join('、')}`)
      }
    }
  }

  // 每个站点/任务的产出都要报出来，否则"结果只来自一个网站"这种问题看不出来
  if (taskResults.length) {
    const byHost = new Map()
    for (const t of taskResults) {
      let host = t.url
      try {
        host = new URL(t.url).hostname
      } catch (_) { /* 用原地址 */ }
      byHost.set(host, (byHost.get(host) || 0) + t.rows)
    }

    report(100, `各站点产出：${[...byHost.entries()].map(([h, n]) => `${h}=${n}条`).join('、')}`)

    const empty = [...byHost.entries()].filter(([, n]) => !n)
    if (empty.length) {
      report(100, `有 ${empty.length} 个站点一条都没抓到：${empty.map(([h]) => h).join('、')}`)
    }
  }

  return {
    rows: deduped.kept,
    pages,
    fields: allFields,
    stopped: stopRequested,
    stats: {
      total: cleaned.length,
      kept: deduped.kept.length,
      deduped: deduped.dropped,
      perTaskPages,
      tasks: taskResults,
      blockedPages: crawlStats.blockedPages,
      droppedBlocked: Math.max(filtered.droppedBlocked, blocked),
      droppedIrrelevant: filtered.droppedIrrelevant,
      droppedByDate: filtered.droppedByDate,
      droppedJunk: filtered.droppedJunk,
      undated: filtered.undated,
      dateRule: filtered.dateRule ? filtered.dateRule.label : ''
    }
  }
}

/** 去重键：标题 + 发布日期（去掉空白和括号，避免同一标题的排版差异被当成两条） */
function dedupeKey (value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, '')
    .replace(/[《》〈〉()（）【】\[\]「」『』·、,，.。:：;；\-—_]/g, '')
    .toLowerCase()
}

/**
 * 多条关键词搜出来的结果合并后去重：标题 + 发布日期都相同视为同一条。
 * 只保留第一条（先搜到的关键词优先），并统计去掉了多少条。
 */
function dedupeRows (rows, fields) {
  const titleField = fields.find((f) => /(标题|名称|项目|公告)/.test(f)) || fields[0] || ''
  const dateField = fields.find((f) => /(日期|时间|发布)/.test(f)) || ''

  const seen = new Set()
  const kept = []
  let dropped = 0

  for (const row of rows) {
    const title = dedupeKey(row[titleField])
    const date = dedupeKey(row[dateField])
    // 标题和日期都取不到时不去重，避免把不同记录误合并
    const key = title || date ? `${title}|${date}` : ''
    if (key && seen.has(key)) {
      dropped += 1
      continue
    }
    if (key) seen.add(key)
    kept.push(row)
  }
  return { kept, dropped }
}

function collectFields (tasks) {
  const set = new Set()
  for (const task of tasks) {
    Object.keys(task.fields || {}).forEach((k) => set.add(k))
  }
  return [...set]
}

/**
 * 一次抓取共用一个浏览器上下文（cookie / 登录状态都在上面），
 * 但页面对象会在导航失败后重置 —— 失败时浏览器会停在 chrome-error 错误页，
 * 直接在上面继续跳转会被它打断，导致后面的任务跟着失败。
 */
function createSession (context) {
  const session = {
    context,
    page: null,
    // 记录已经尝试过自动登录的站点，避免每个详情页都提交一次
    loginAttempted: new Set(),
    // 记录已经"捂热"过的站点，避免每个页面都先访问一次首页
    warmed: new Set(),
    async reset () {
      const oldPage = session.page

      // 先建好新页面：旧页面可能卡在未完成的导航上，
      // 等它 close() 会一直卡住，所以旧的丢到后台去关
      const nextPage = await session.context.newPage()
      nextPage.setDefaultTimeout(Number(config.PAGE_TIMEOUT) || 45000)
      session.page = nextPage

      if (oldPage) oldPage.close().catch(() => {})
      return session.page
    }
  }
  return session
}

async function crawlTask ({
  session,
  task,
  passwordBook,
  rows,
  pages,
  budget,
  taskBudget,
  visited,
  crawlStats,
  report,
  taskIndex,
  taskTotal
}) {
  const base = Math.round((taskIndex / taskTotal) * 100)
  const span = Math.round(100 / taskTotal)

  // 本任务还能开几个页面：全局预算和本任务额度都要满足
  const canOpen = () => budget.left > 0 && taskBudget.left > 0
  const takePage = () => {
    budget.left -= 1
    taskBudget.left -= 1
  }
  const remain = () => Math.max(0, Math.min(budget.left, taskBudget.left))

  const entry = await openPage(session, task.url, passwordBook, (m) => report(base, m))
  visited.add(task.url)
  takePage()

  const $entry = cheerio.load(entry.html)
  pages.push({ url: entry.url, title: entry.title, text: getMainText($entry) })

  const listSelector = String(task.selector || '').trim()

  // 列表页：要么直接按列表项取字段，要么进入详情页取字段
  if (listSelector && task.followDetail !== false) {
    // 翻页多抓一些：只抓第一页往往只有十几条，远少于站点实际数量。
    // 每个关键词翻几页由搜索计划决定（3~5 页），这里再夹一次上限保护。
    const maxListPages =
      task.followPagination === false
        ? 1
        : Math.min(
            Number(task.maxPages) || Number(config.MAX_LIST_PAGES) || 3,
            Number(config.MAX_LIST_PAGES_MAX) || 5
          )
    // 单个关键词每一页最多抓多少条详情，避免一页几十条把预算一次吃光；
    // 每个关键词的总上限更大一些，这样"翻 3~5 页"才真正生效
    const maxItemsPerPage = Number(config.MAX_ITEMS_PER_PAGE) || 10
    const maxItems = Math.min(Number(config.MAX_ITEMS_PER_KEYWORD) || 20, taskBudget.left)
    let pageUrl = entry.url
    let html = entry.html
    let totalItems = 0
    let listPageCount = 0
    let itemsThisTask = 0

    for (let pageNo = 0; pageNo < maxListPages; pageNo++) {
      if (stopRequested || !canOpen() || itemsThisTask >= maxItems) {
        if (!canOpen() && pageNo > 0) report(base, '本任务页面额度用完，停止翻页')
        if (itemsThisTask >= maxItems) {
          report(base, `本关键词已抓满 ${maxItems} 条，停止翻页`)
        }
        break
      }
      listPageCount += 1

      const $page = pageNo === 0 ? $entry : cheerio.load(html)
      let targets = collectItems($page, listSelector, pageUrl, task.listFields)

      // 列表常常是异步渲染的：外壳先出来，条目要等几秒，中途还会显示"暂无数据"占位。
      // 所以这里不能只等"页面有文字"，要等选择器真的命中条目，否则会把
      // "还没渲染完"误判成"这个站点没有数据"，整页一条都抓不到。
      if (!targets.length && listSelector) {
        for (let retry = 0; retry < 2 && !targets.length; retry++) {
          if (stopRequested) break
          report(base, `第 ${pageNo + 1} 页还没渲染出条目，等列表加载…`)
          // 等不到条目就别再等第二轮了，空页面白等 20 秒不划算
          if (!(await waitForListItems(session.page, listSelector, 20000))) break
          const refreshed = await withTimeout(session.page.content(), 20000, '读取页面内容').catch(() => '')
          if (!refreshed) break
          html = refreshed
          targets = collectItems(cheerio.load(html), listSelector, pageUrl, task.listFields)
        }
      }

      if (!targets.length) break

      totalItems += targets.length
      const max = Math.min(targets.length, remain(), maxItems - itemsThisTask, maxItemsPerPage)
      const kwLabel = task.keyword ? `关键词「${task.keyword}」` : ''
      report(
        base,
        `${kwLabel}第 ${pageNo + 1}/${maxListPages} 页解析到 ${targets.length} 条链接，本次抓取前 ${max} 条`
      )

      for (let i = 0; i < max; i++) {
        if (stopRequested) break
        const item = targets[i]
        const url = item.href
        if (visited.has(url)) continue
        visited.add(url)
        takePage()
        itemsThisTask += 1

        try {
          const detail = await openPage(session, url, passwordBook, (m) => report(base, m))
          let $d = cheerio.load(detail.html)
          let detailUrl = detail.url
          let detailTitle = detail.title

          // 命中风控/验证码：多关键词连续搜同一个站点很容易被限流，
          // 换一个干净会话再试一次，能救回不少数据；还是不行才跳过
          if (isBlockedText(getMainText($d)) || isBlockedText(detailTitle)) {
            report(base, `详情页命中人机验证，换个会话重试：${truncate(url, 50)}`)
            await session.reset()
            try {
              const again = await openPage(session, url, passwordBook, (m) => report(base, m))
              const $again = cheerio.load(again.html)
              if (!isBlockedText(getMainText($again)) && !isBlockedText(again.title)) {
                $d = $again
                detailUrl = again.url
                detailTitle = again.title
              }
            } catch (_) { /* 重试也失败，按风控页处理 */ }
          }

          if (isBlockedText(getMainText($d)) || isBlockedText(detailTitle)) {
            crawlStats.blockedPages += 1
            report(base, `详情页仍是验证页，跳过：${truncate(url, 50)}`)
            continue
          }

          rows.push(mergeListItem($d, task.fields, detailUrl, item.values))
          if (pages.length < 30) {
            pages.push({ url: detailUrl, title: detailTitle, text: getMainText($d) })
          }
          report(
            base + Math.round((((pageNo + i / Math.max(max, 1)) / maxListPages) * span)),
            `${kwLabel}累计 ${rows.length} 条：${truncate(detailTitle || detailUrl, 40)}`
          )
        } catch (err) {
          report(base, `详情页失败：${url}（${err.message}）`)
        }
      }

      // 找下一页
      if (pageNo + 1 >= maxListPages) break
      const next = findNextPageUrl($page, pageUrl, pageUrl)
      if (!next || visited.has(next) || !canOpen()) break

      visited.add(next)
      takePage()
      report(base, `继续翻页：${next}`)
      try {
        const nextPage = await openPage(session, next, passwordBook, (m) => report(base, m))
        pageUrl = nextPage.url
        html = nextPage.html
        if (isBlockedText(getMainText(cheerio.load(html)))) {
          report(base, '翻页时命中人机验证，停止翻页')
          break
        }
      } catch (err) {
        report(base, `翻页失败：${err.message}`)
        break
      }
    }

    if (!totalItems) {
      report(base, '列表页没解析到条目（选择器可能失效）')
    } else {
      report(base, `本任务共解析到 ${totalItems} 条链接`)
    }
    return { listPages: listPageCount, items: totalItems }
  }

  const targets = listSelector ? collectItems($entry, listSelector, entry.url, task.listFields) : []

  // 列表项自带字段：直接从列表项抽取
  if (targets.length && listSelector) {
    try {
      $entry(listSelector).each((_, el) => {
        rows.push(extractRow($entry, $entry(el), task.fields, entry.url))
      })
      report(base + span, `已抓取 ${rows.length} 条`)
      return { listPages: 1, items: targets.length }
    } catch (_) { /* 落到单页模式 */ }
  }

  // 单页模式
  rows.push(extractRow($entry, $entry.root(), task.fields, entry.url))
  report(base + span, `已抓取 1 条：${truncate(entry.title || entry.url, 40)}`)
  return { listPages: 1, items: 1 }
}

/**
 * 详情页取数，缺的字段用列表行的值补上
 */
function mergeListItem ($, fields, pageUrl, listValues) {
  const { values, specs } = pickFields($, $.root(), fields, pageUrl)

  // 注意：这里要遍历"列表行的字段"，不能遍历详情页的字段 ——
  // 列表行独有的字段（比如日期、标题）在详情页字段里根本没有键
  if (listValues) {
    for (const [name, value] of Object.entries(listValues)) {
      if (value && !values[name]) values[name] = value
    }
  }

  if (!Object.values(values).some(Boolean)) fallbackFill($, values, specs)

  values.__source = pageUrl
  return values
}

// 明显的导航/占位条目，不是真实记录
const NAV_TEXT = /^(首页|主页|更多|更多>>|更多>|上一页|下一页|尾页|返回|登录|注册|联系我们|网站地图|关于我们|列表|全部|搜索|查看更多|点击查看更多)$/

// 站点风控 / 人机验证页面的特征：这种页面绝不能当成公告内容
const BLOCK_HINT =
  /(滑动验证|访问验证|安全验证|人机验证|请按住滑块|请输入验证码|请输入正确的验证码|访问过于频繁|请求过于频繁|操作太频繁|访问受限|verify|captcha|are you a robot|unusual traffic)/i

// 行业资讯类标题（不是招标公告），比如"2014年风电产业监测情况 - 今日焦点"
const NEWS_TITLE =
  /(监测情况|监测报告|行业动态|市场分析|市场解读|焦点|快讯|盘点|周报|月报|年报|观察|解读|趋势|资讯|新闻)/

function isBlockedText (text) {
  return BLOCK_HINT.test(String(text || ''))
}

/** 从文本里取年份，用于识别"2014年xx情况"这类过时文章 */
function parseRowYear (value) {
  const m = String(value == null ? '' : value).match(/(19|20)\d{2}\s*年/)
  return m ? Number(m[0].replace(/\D/g, '')) : null
}

/** 去掉检索站加在标题后面的"（风电 在正文中）"这类标记 */
function stripSnippetMarker (text) {
  return String(text == null ? '' : text)
    .replace(/[（(]\s*[^）)]{0,16}在正文[^）)]{0,8}[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从文本里解析日期（支持 2026-08-31 / 2026年8月31日 / 2026/8/31 / 08-31） */
function parseRowDate (value) {
  const s = String(value == null ? '' : value)
  const full = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/)
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]))

  const short = s.match(/(?:^|\D)(\d{1,2})\s*[-/月]\s*(\d{1,2})/)
  if (short) return new Date(new Date().getFullYear(), Number(short[1]) - 1, Number(short[2]))

  return null
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 把 'YYYY-MM-DD' / 'YYYY/M/D' / 'YYYY年M月D日' 解析成 Date */
function parseRangeDate (value) {
  const m = String(value || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 用户在「爬取时间段」里明确选的日期区间。
 * 这个区间优先于规则设置里的时间描述：规则是给 AI 读的自然语言，
 * 这里是用户点的确定区间，两者冲突时以它为准。
 */
function buildExplicitRange (dateRange) {
  if (!dateRange) return null
  const from = parseRangeDate(dateRange.from)
  const to = parseRangeDate(dateRange.to)
  if (!from && !to) return null

  const start = from || new Date(1970, 0, 1)
  // 结束日当天也算在内，所以要取到次日
  const end = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : new Date(8640000000000)
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  return {
    label: `${from ? fmt(from) : '不限'} ~ ${to ? fmt(to) : '不限'}（用户指定时间段，优先于规则）`,
    test: (date) => date >= start && date < end
  }
}

/**
 * 把用户规则里的时间要求变成确定性过滤条件。
 * 规则让 AI 判断是不够的 —— "只要九月份"这种要求必须本地严格执行，
 * 否则八月份的数据照样会出现在结果里。
 */
function buildDateRule (rules) {
  const text = String(rules || '')
  const now = new Date()

  const days = text.match(/近\s*(\d+)\s*天/)
  if (days) {
    const from = new Date(now.getTime() - Number(days[1]) * 86400000)
    return { label: `近 ${days[1]} 天`, test: (date) => date >= from }
  }

  const monthsAgo = text.match(/近\s*(\d+)\s*个?月/)
  if (monthsAgo) {
    const from = new Date(now)
    from.setMonth(from.getMonth() - Number(monthsAgo[1]))
    return { label: `近 ${monthsAgo[1]} 个月`, test: (date) => date >= from }
  }

  const cnMonth = text.match(/([一二三四五六七八九十]{1,2})\s*月(份)?/)
  if (cnMonth) {
    const raw = cnMonth[1]
    const month = raw.length === 1 ? CN_NUM[raw] : 10 + (CN_NUM[raw[1]] || 0)
    if (month >= 1 && month <= 12) {
      const year = now.getFullYear()
      const start = new Date(year, month - 1, 1)
      const end = new Date(year, month, 1)
      return { label: `${year} 年 ${month} 月`, test: (date) => date >= start && date < end }
    }
  }

  const numMonth = text.match(/(\d{1,2})\s*月(份)?/)
  if (numMonth) {
    const month = Number(numMonth[1])
    if (month >= 1 && month <= 12) {
      const year = now.getFullYear()
      const start = new Date(year, month - 1, 1)
      const end = new Date(year, month, 1)
      return { label: `${year} 年 ${month} 月`, test: (date) => date >= start && date < end }
    }
  }

  return null
}

/** 找列表页的"下一页"链接，用于翻页多抓一些 */
function findNextPageUrl ($, baseUrl, currentUrl) {
  const words = ['下一页', '下页', '后一页', '下一頁', 'next', '›', '»', '>>']
  let found = ''

  $('a').each((_, el) => {
    const $el = $(el)
    const text = clean($el.text()).toLowerCase()
    const rel = String($el.attr('rel') || '').toLowerCase()
    const cls = String($el.attr('class') || '').toLowerCase()
    const isNext = rel === 'next' || words.includes(text) || /next/.test(cls)
    if (!isNext) return
    const href = absolute($el.attr('href'), baseUrl)
    if (href && href !== currentUrl && /^https?:/i.test(href)) {
      found = href
      return false
    }
  })

  return found
}

/**
 * 主题相关性过滤 —— 这一步是"准确度"的兜底：
 * 列表页里往往混着导航、别的栏目内容、甚至风控页，只有确实和主题相关的才留下。
 */
function filterRows (rows, fields, keywords, rules, dateRange) {
  const titleField = fields.find((f) => /(标题|名称|项目|公告)/.test(f)) || fields[0] || ''
  const dateField = fields.find((f) => /(日期|时间|发布)/.test(f)) || ''
  // 用户点的「爬取时间段」优先；没指定才用规则里的时间描述
  const dateRule = buildExplicitRange(dateRange) || buildDateRule(rules)

  const kept = []
  let droppedIrrelevant = 0
  let droppedJunk = 0
  let droppedBlocked = 0
  let droppedByDate = 0
  let undated = 0

  for (const row of rows) {
    const values = fields.map((f) => stripSnippetMarker(row[f]))
    const longest = values.reduce((max, v) => Math.max(max, v.length), 0)
    const title = stripSnippetMarker(row[titleField])

    // 风控页/验证码页绝不当数据
    if (isBlockedText(values.join(' '))) {
      droppedBlocked += 1
      continue
    }

    if (longest < 8 || NAV_TEXT.test(title)) {
      droppedJunk += 1
      continue
    }

    // 行业资讯/新闻类标题也不是招标公告
    if (NEWS_TITLE.test(title)) {
      droppedJunk += 1
      continue
    }

    if (keywords.length) {
      // 标题里必须出现主题核心词 —— 只靠正文提到"风电"的（土地出让、康养基地之类）不算
      const haystack = title && title.length >= 6 ? title.toLowerCase() : values.join(' ').toLowerCase()
      if (!keywords.some((k) => haystack.includes(String(k).toLowerCase()))) {
        droppedIrrelevant += 1
        continue
      }
    }

    if (dateRule && dateField) {
      // 日期可能只在标题里（有些站点的日期字段没抽到）
      let date = parseRowDate(row[dateField]) || parseRowDate(title)

      if (!date) {
        // 标题里只有年份的老文章（例如"2014年风电产业监测情况"）也算时间不符
        const year = parseRowYear(title) || parseRowYear(row[dateField])
        if (year && year !== new Date().getFullYear()) {
          droppedByDate += 1
          continue
        }
      } else if (!dateRule.test(date)) {
        droppedByDate += 1
        continue
      }

      if (!date) undated += 1
    }

    kept.push(row)
  }

  return {
    kept,
    droppedIrrelevant,
    droppedJunk,
    droppedBlocked,
    droppedByDate,
    undated,
    dateRule
  }
}

/** 清洗 + 去重 */
function normalizeRows (rows, fields) {
  const seen = new Set()
  const out = []

  for (const row of rows) {
    const item = {}
    let empty = true
    for (const f of fields) {
      const val = clean(row[f]).slice(0, 5000)
      item[f] = val
      if (val) empty = false
    }
    if (empty) continue

    if (row.__source) item.__source = row.__source

    const key = fields.map((f) => item[f]).join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
