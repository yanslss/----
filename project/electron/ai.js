import config from '../config.js'

// ============ 内置提示词模板 ============

// 站点推荐阶段
const SITE_SYSTEM_PROMPT = `你是站点调研助手。根据用户给出的主题和规则，推荐最可能有对应内容的网站，并给出用于检索和相关性过滤的关键词。
输出 JSON：
{"sites": [{"url": "...", "name": "...", "reason": "..."}], "keywords": ["关键词1", "关键词2"], "topicKeywords": ["核心词1", "核心词2"]}
要求：
1. sites 给 3~8 个，优先官方/权威来源（政府采购网、公共资源交易中心、行业协会、大型企业采购与招标平台、行业媒体等）。
   url 必须是"能直接看到公告列表"的栏目页或列表页，不要给新闻/政策栏目，也不要给首页以外的深层文章地址。
2. 只推荐真实存在、公开可访问的网站，不要编造域名。
3. keywords 给 2~4 个，用于搜索引擎检索，要贴合主题与规则。
4. topicKeywords 是"判断一条记录是否与主题相关"的关键词，必须包含主题的核心词及其同义/近义说法。
   例如主题是"风电项目招标公告"，就应给出 ["风电","风力发电","风电场","风机","风电机组","风电项目"]。
   每条 2~6 个字，不要包含"招标/公告/采购/项目"这类通用词，给 3~8 个。
5. 只输出 JSON，不要解释。`

// 搜索规划阶段
const SEARCH_PLAN_SYSTEM_PROMPT = `你是搜索规划助手。根据用户给出的主题、字段和规则，把主题扩展成一批用于站内/搜索引擎检索的关键词，并为每个关键词给出搜索计划。
输出 JSON：
{"keywords": ["风电", "风力发电", "风电场", "风机", "风电项目", "风电招标"], "search_plan": [{"keyword": "风电", "search_type": "title", "date_range": "近30天", "max_pages": 5}], "topicKeywords": ["风电", "风力发电", "风电场"]}
要求：
1. keywords 给 8~15 个，必须覆盖以下几类，不要只给同一种说法：
   - 主题本身 + 同义词/别名（例如"风电 / 风力发电 / 风能 / 海上风电"）
   - 行业上下游与相关词（例如"风机 / 风电机组 / 塔筒 / 叶片 / 升压站 / 吊装 / 逆变器"）
   - 采购口径的搭配词（例如"风电项目 / 风电场工程 / 风电设备采购 / 风机采购"）
   - 如果主题或规则里出现了地区，补上"地区 + 主题"的组合词
2. 每个关键词 2~10 个字，不要重复、不要带标点。
3. search_plan 与 keywords 一一对应，每项包含：
   - keyword：原样照抄 keywords 里的词
   - search_type：词很宽泛（例如"风电"）填 "title"，词很精确的长词填 "content"
   - date_range：默认"不限"；如果规则或爬取时间段里给了范围就照着写（例如"近30天""2026-09-01 ~ 2026-09-30"）
   - max_pages：3~5 的整数，词越宽泛、预计结果越多就给得越大
4. topicKeywords 是"判断一条记录是否与主题相关"的核心词，必须包含主题核心词及其同义说法，
   给 3~8 个、每个 2~6 字，不要包含"招标/公告/采购/项目"这类通用词。
5. 只输出 JSON，不要解释。`

// 规划阶段
const PLAN_SYSTEM_PROMPT = `你是爬虫规划助手。根据用户提供的主题、规则、链接和字段，输出 JSON 格式的爬取计划：
{"tasks": [{"url": "...", "selector": "...", "fields": {"日期": "...", "项目名称": "..."}}]}
只输出 JSON，不要解释。

这次会额外提供「页面结构摘要」，它是程序真实打开页面后采集到的信息：
- listPages[].lists：页面上重复出现的块，含可直接使用的列表项选择器、命中条数和文本样例
- listPages[].linkSamples：页面上链接文字样例
- sampleDetail.titleSelector / dates / blocks：详情页样本里标题、日期、正文容器的真实选择器

补充约定（仍然只输出 JSON）：
1. tasks[].url 必须从候选页面里挑，不要自己编造地址。
2. 挑选顺序：优先「类型=站内检索结果页」的列表页（它是用主题在站内搜出来的，和主题最相关），其次「栏目页」，最后才是「入口页」。
   每个站点只要有一个和主题相关的列表页，就必须为它出一个任务，不要漏掉站点；同一个站点有多个相关列表页时也可以出多个任务。
3. tasks[].selector 只能从 listPages[].lists 里「主题相关=是」的候选中挑（挑最能对上"每一条记录"的那个），照抄选择器字符串，不要改写、不要自己拼；
   如果某个列表页没有任何「主题相关=是」的候选，就不要为它出任务。
4. tasks[].fields 的键必须与用户字段完全一致；值是该字段在详情页上的 CSS 选择器，优先从 sampleDetail 的 titleSelector / dates / blocks 里取；确定不了就填 ""。
5. followDetail：列表页填 true；该链接本身就是详情页则填 false。
6. tasks[].listFields（可选）：如果列表页的每一行里就带着某些字段（常见的如日期、标题），把字段名和"相对列表项"的选择器填在这里。跟进详情页抓取时，详情页里取不到的字段会自动用列表行的值补上。
7. 如果某个站点没有详情页样本（详情页样本为 null），就优先用 followDetail:false，让字段选择器直接作用在列表行上，并用 listFields 取列表行里的字段。
8. 可以附加 summary 字段，用一句话说明计划思路。`

// 校验阶段
const VALIDATE_SYSTEM_PROMPT = `你是数据校验助手。检查以下爬取结果是否完整、字段是否对齐、是否有重复，并严格按主题剔除无关数据。输出修正后的 JSON 数组和简短说明。
输出格式（只输出 JSON，不要解释）：
{"rows": [{"字段名": "值"}], "issues": ["发现的问题"], "summary": "整体说明"}
要求：
1. rows 里每个对象的键必须与"字段"列表中给出的字段名完全一致，不要新增、不要改名。
2. 【最重要】逐条判断是否真的和"主题"相关，与主题无关的记录必须删除，宁少勿滥：
   - 标题里只是"顺带提到"主题词的也要删。例如检索站会给标题加"（风电 在正文中）"这种标注，
     这类多半是土地出让、森林康养、垃圾站采购之类的公告，和风电招标无关，必须删除。
   - 网站导航、栏目名、登录提示、验证码提示（如"人机验证""请求过于频繁"）都不是数据，必须删除。
   - 政府采购政策新闻、其他行业的中标公示，也都不算，必须删除。
3. 按用户自定义规则过滤：若规则里给了时间范围（如"只抓九月份""近30天""近三个月"），
   日期不在范围内的记录必须删除；日期缺失的记录保留但要在 issues 里说明。
   如果给了"爬取时间段"，以它为准（它优先级高于规则里的时间描述），不在这个区间内的记录必须删除。
4. 去掉重复数据：把"标题 + 发布日期"都相同的记录视为同一条，只保留一条。
5. 检查字段完整性：缺失的字段一律留空，不要凭空编造（这次只给你提取好的结构化数据，
   没有页面原文可参考）；并把"哪一条缺了哪个字段"写进 issues（例如"第 7 条缺 发布日期"），
   便于用户核对。
6. 只保留确实存在的值。
7. 如果过滤后一条都不剩，就返回空数组，并在 issues 里说明为什么都被判为无关。
8. 最后请把"删除了哪些、为什么删"简短写进 issues，便于用户核对。`

// ============ 基础请求 ============

/**
 * 测试 API 是否可用（设置弹窗里的"测试"按钮）：
 * 直接发一次最小的 chat 请求，能返回内容就算通。
 */
export async function testApiConnection ({ baseUrl, apiKey, model } = {}) {
  const key = String(apiKey || config.DEEPSEEK_API_KEY || '').trim()
  if (!key) throw new Error('请先填写 API 密钥')

  const base = String(baseUrl || config.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
  const useModel = String(model || config.DEEPSEEK_MODEL || 'deepseek-chat')

  const timeout = Number(config.REQUEST_TIMEOUT) || 60000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0
      }),
      signal: controller.signal
    })

    const body = await res.text().catch(() => '')
    if (!res.ok) {
      throw new Error(`接口返回 ${res.status}：${body.slice(0, 200)}`)
    }
    return { ok: true, model: useModel, message: '连接成功' }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调用 DeepSeek，返回解析后的 JSON 对象
 */
async function chatJSON (systemPrompt, userPrompt, temperature = 0.2) {
  const key = String(config.DEEPSEEK_API_KEY || '').trim()
  if (!key || key.includes('REPLACE_ME') || key.includes('请填写')) {
    throw new Error('还没配置 AI 接口，请点右下角「设置」填写 API 地址和密钥，或写进 project/.env')
  }

  const base = String(config.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
  const timeout = Number(config.REQUEST_TIMEOUT) || 60000

  // 按要求：前端请求 DeepSeek 超时 60 秒
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: config.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`DeepSeek 接口返回 ${res.status}：${body.slice(0, 300)}`)
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''
    return parseJSON(content)
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`DeepSeek 请求超时（${Math.round(timeout / 1000)} 秒）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 容错解析：AI 有时会包一层 ```json 代码块
 */
function parseJSON (text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('AI 未返回任何内容')

  const stripped = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  try {
    return JSON.parse(stripped)
  } catch (_) { /* 继续尝试截取 */ }

  const start = stripped.search(/[[{]/)
  const end = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1))
    } catch (_) { /* 放弃 */ }
  }
  throw new Error(`AI 返回的内容不是合法 JSON：${stripped.slice(0, 200)}`)
}

function truncate (value, max) {
  const s = String(value == null ? '' : value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 字段说明：带「编辑爬取内容」里的数据类型和备注时一起给 AI，帮它找准位置 */
function describeFields (input) {
  const defs = Array.isArray(input.fieldDefs) ? input.fieldDefs.filter((d) => d && d.name) : []
  if (defs.length) {
    return defs
      .map((d) => {
        const type = String(d.type || '').trim()
        const note = String(d.note || '').trim()
        return `${d.name}${type ? `（类型：${type}）` : ''}${note ? `（备注：${note}）` : ''}`
      })
      .join('、')
  }
  return (input.fields || []).filter(Boolean).join('、') || '未提供'
}

/** 用户指定的爬取时间段（优先于规则里的时间描述） */
function describeRange (input) {
  const from = String(input?.dateRange?.from || '').trim()
  const to = String(input?.dateRange?.to || '').trim()
  return from && to ? `${from} ~ ${to}` : ''
}

// ============ 职责一：站点推荐 ============

/**
 * 根据主题推荐站点与搜索关键词（不需要看页面，纯知识）
 * @param {{topic:string, rules:string, links:string[]}} input
 */
export async function recommendSites (input) {
  const links = (input.links || []).filter(Boolean)
  const userPrompt = [
    `主题：${input.topic || ''}`,
    '',
    `自定义规则：${input.rules ? input.rules : '无'}`,
    '',
    '用户自己已经提供的链接：',
    links.length ? links.map((u, i) => `${i + 1}. ${u}`).join('\n') : '无',
    '',
    '请再推荐其他可能有同类内容的网站，并给出检索关键词。'
  ].join('\n')

  const json = await chatJSON(SITE_SYSTEM_PROMPT, userPrompt)

  const sites = (Array.isArray(json.sites) ? json.sites : [])
    .map((s) => ({
      url: String(s?.url || '').trim(),
      name: String(s?.name || '').trim(),
      reason: String(s?.reason || '').trim()
    }))
    .filter((s) => /^https?:\/\//i.test(s.url))

  const keywords = (Array.isArray(json.keywords) ? json.keywords : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .slice(0, 4)

  // 用来判断"一条记录是否和主题相关"的核心词（含同义说法）
  const topicKeywords = normalizeTopicKeywords(json.topicKeywords)

  return { sites, keywords, topicKeywords }
}

// ============ 职责二：搜索规划（多关键词） ============

export async function planSearch (input) {
  const userPrompt = [
    `主题：${input.topic || ''}`,
    '',
    `自定义规则：${input.rules ? input.rules : '无'}`,
    '',
    `需要的字段：${describeFields(input)}`,
    `爬取时间段：${describeRange(input) || '未指定'}`,
    '',
    '请给出扩展关键词和每个关键词的搜索计划。'
  ].join('\n')

  // 温度 0：搜索词要稳定可复现，不需要发散
  const json = await chatJSON(SEARCH_PLAN_SYSTEM_PROMPT, userPrompt, 0)

  const keywords = normalizeKeywords(json.keywords).slice(0, Number(config.MAX_KEYWORDS) || 12)

  const planMap = new Map()
  for (const item of Array.isArray(json.search_plan) ? json.search_plan : []) {
    const keyword = String(item?.keyword || '').trim()
    if (!keyword) continue
    planMap.set(keyword, {
      keyword,
      // 站点不一定认这个参数，仅作为"建议"展示与记录
      searchType: /content|正文|内容/i.test(String(item?.search_type || '')) ? 'content' : 'title',
      dateRange: String(item?.date_range || '').trim() || '不限',
      maxPages: clampPages(item?.max_pages)
    })
  }

  const plan = keywords.map(
    (keyword) =>
      planMap.get(keyword) || {
        keyword,
        searchType: 'title',
        dateRange: '不限',
        maxPages: clampPages(null)
      }
  )

  const topicKeywords = normalizeTopicKeywords(json.topicKeywords)

  return { keywords, plan, topicKeywords }
}

/** 关键词清洗：去空、去标点、去重，太短太长的丢弃 */
function normalizeKeywords (list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const word = String(item || '')
      .replace(/[，,。.、；;：:！!？?"'“”()（）【】\[\]]/g, ' ')
      .replace(/\s+/g, '')
      .trim()
    if (word.length < 2 || word.length > 14) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/** 核心词：判断"一条记录是否与主题相关"，和搜索关键词是两回事 */
function normalizeTopicKeywords (list) {
  return (Array.isArray(list) ? list : [])
    .map((k) => String(k || '').trim())
    .filter((k) => k.length >= 2 && k.length <= 8)
    .slice(0, 10)
}

/** 每个关键词翻几页：至少 3 页，最多 5 页（再多就抓太久了） */
function clampPages (value) {
  const min = Number(config.MIN_PAGES_PER_KEYWORD) || 3
  const max = Number(config.MAX_LIST_PAGES_MAX) || 5
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return min
  return Math.min(Math.max(n, min), max)
}

// ============ 职责三：规划阶段 ============

/**
 * 生成爬取计划
 * @param {{topic:string, rules:string, fields:string[], links?:string[], sites?:Array}} input
 *        sites 是 analyze 采到的页面结构摘要，有它才能给出准确的选择器
 * @returns {Promise<{tasks:Array, summary:string}>}
 */
export async function generatePlan (input) {
  const fields = (input.fields || []).filter(Boolean)
  const sites = Array.isArray(input.sites) ? input.sites.filter((s) => s && s.url) : []

  // 没有页面摘要时只能按常见约定给选择器
  if (!sites.length) {
    const json = await chatJSON(PLAN_SYSTEM_PROMPT, buildPromptForSites([], input))
    const tasks = mapTasks(json, input, null)
    if (!tasks.length) throw new Error('AI 未生成有效的爬取任务，请检查链接是否可访问')
    return { tasks: expandTasksByKeywords(tasks, input), summary: String(json.summary || '') }
  }

  // 站点多了以后 AI 容易只挑一两个站点出任务（结果就"只来自一个网站"），
  // 所以按 3 个一组分批请求，每组都明确要求覆盖组内每个站点；
  // 之后再检查覆盖情况，AI 漏掉的用摘要兜底补上。
  const CHUNK = 3
  const tasks = []
  const summaries = []
  const notes = []

  for (let i = 0; i < sites.length; i += CHUNK) {
    const chunk = sites.slice(i, i + CHUNK)
    let json
    try {
      json = await chatJSON(PLAN_SYSTEM_PROMPT, buildPromptForSites(chunk, input))
    } catch (err) {
      notes.push(`第 ${i + 1}~${i + chunk.length} 个站点规划失败：${err.message}`)
      continue
    }

    const mapped = mapTasks(json, input, hostsOf(chunk))
    tasks.push(...mapped)
    if (json.summary) summaries.push(String(json.summary))

    const covered = new Set(mapped.map((t) => safeHost(t.url)))
    for (const site of chunk) {
      if (covered.has(safeHost(site.url))) continue
      const fallback = fallbackTaskForSite(site, fields)
      if (!fallback) {
        notes.push(`${site.url} 没被规划进任务，摘要也不足以兜底`)
        continue
      }
      tasks.push(fallback)
      notes.push(`${safeHost(site.url)} 已按页面结构摘要自动补上任务`)
    }
  }

  const seenUrl = new Set()
  const unique = tasks.filter((t) => {
    if (seenUrl.has(t.url)) return false
    seenUrl.add(t.url)
    return true
  })

  if (!unique.length) throw new Error('AI 未生成有效的爬取任务，请检查链接是否可访问')

  // 站点任务 → 多关键词批量搜索任务
  const expanded = expandTasksByKeywords(unique, input)

  return { tasks: expanded, summary: [...summaries, ...notes].filter(Boolean).join(' ') }
}

/**
 * 把"每个站点一个任务"展开成"每个站点 × 每个关键词一个任务"。
 * 依据是 analyze 采到的站内检索地址模板（地址 + 关键词参数名）：
 * 用同一个模板替换不同的关键词，就得到同一站点下多个关键词的检索结果页 —— 这就是多关键词批量搜索。
 */
function expandTasksByKeywords (tasks, input) {
  const keywords = (input.searchKeywords || []).map((k) => String(k || '').trim()).filter(Boolean)
  if (!keywords.length) return tasks

  const planMap = new Map(
    (Array.isArray(input.searchPlan) ? input.searchPlan : []).map((p) => [String(p?.keyword || ''), p])
  )
  const siteByHost = new Map((input.sites || []).map((s) => [safeHost(s.url), s]))
  const limit = Number(config.MAX_KEYWORDS_PER_SITE) || 6

  const out = []
  const seen = new Set()
  const push = (task) => {
    const key = `${task.url}##${task.keyword || ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(task)
  }

  for (const task of tasks) {
    const template = siteByHost.get(safeHost(task.url))?.searchTemplate
    const keywordTasks = []

    for (const keyword of keywords.slice(0, limit)) {
      const url = withSearchKeyword(template?.url, template?.param, keyword)
      if (!url) continue
      const item = planMap.get(keyword) || {}
      keywordTasks.push({
        ...task,
        url,
        keyword,
        // 这个关键词该翻几页（来自搜索计划）
        maxPages: Number(item.maxPages) || undefined,
        searchType: item.searchType || 'title'
      })
    }

    // 站点没有可复现的检索地址时，保持原来的单任务
    if (!keywordTasks.length) {
      push(task)
      continue
    }
    keywordTasks.forEach(push)
  }

  return out
}

/** 把关键词填进检索地址的对应参数里 */
function withSearchKeyword (url, param, keyword) {
  const name = String(param || '').trim()
  if (!url || !name) return ''
  try {
    const u = new URL(url)
    u.searchParams.set(name, keyword)
    return u.href
  } catch (_) {
    return ''
  }
}

function safeHost (url) {
  try {
    return new URL(url).hostname
  } catch (_) {
    return String(url || '')
  }
}

function hostsOf (sites) {
  const hosts = new Set()
  for (const site of sites) {
    for (const raw of [site.url, site.finalUrl]) {
      const h = safeHost(raw)
      if (h) hosts.add(h)
    }
    for (const page of site.listPages || []) {
      const h = safeHost(page.url)
      if (h) hosts.add(h)
    }
  }
  return hosts
}

function buildPromptForSites (sites, input) {
  const links = (input.links || []).filter(Boolean)
  const range = describeRange(input)

  const head = [
    `主题：${input.topic || ''}`,
    '',
    `自定义规则：${input.rules ? input.rules : '无'}`,
    '',
    `需要的字段：${describeFields(input)}`,
    `爬取时间段：${range || '未指定'}${range ? '（用户明确选的区间，优先于规则里的时间描述）' : ''}`
  ]

  if (!sites.length) {
    return [
      ...head,
      '',
      '起始链接：',
      links.length ? links.map((u, i) => `${i + 1}. ${u}`).join('\n') : '无',
      '',
      '（没有页面结构信息，选择器请用常见约定，例如 .list li / .news-list li / .article-content）'
    ].join('\n')
  }

  return [
    ...head,
    '',
    `本次处理的站点（共 ${sites.length} 个，每一个都必须出至少一个任务，不允许遗漏）：`,
    JSON.stringify(buildDigestPayload(sites), null, 1),
    '',
    '请据此生成爬取计划：每个站点选它最相关、最完整的那个列表页出任务；字段选择器用摘要里给出的真实选择器。'
  ].join('\n')
}

function mapTasks (json, input, allowedHosts) {
  const fields = (input.fields || []).filter(Boolean)
  const links = (input.links || []).filter(Boolean)

  return (Array.isArray(json?.tasks) ? json.tasks : [])
    .filter((t) => t && t.url)
    .filter((t) => {
      const url = String(t.url).trim()
      if (!allowedHosts || !allowedHosts.size) return true
      if (links.includes(url)) return true
      return allowedHosts.has(safeHost(url))
    })
    .map((t) => ({
      url: String(t.url).trim(),
      selector: String(t.selector || t.listSelector || '').trim(),
      followDetail: t.followDetail !== false,
      fields: normalizeFieldMap(t.fields, fields),
      // 列表行自带的字段，抓详情页时用来补空缺
      listFields: t.listFields ? normalizeFieldMap(t.listFields, fields) : null,
      note: t.note ? String(t.note) : ''
    }))
}

/**
 * AI 漏掉某站点时的兜底任务：直接用页面结构摘要里的选择器。
 * 不如 AI 精细，但能保证"推荐的平台"不被整站漏掉。
 */
function fallbackTaskForSite (site, fields) {
  const page = (site.listPages || [])[0]
  if (!page || !page.url) return null

  const bestList = (page.lists || []).find((l) => l.hasLink) || (page.lists || [])[0]
  const detail = site.sampleDetail || null

  const pickFieldSelector = (name) => {
    if (/日期|时间|发布/.test(name)) return detail?.dates?.[0]?.selector || ''
    if (/标题|名称|项目|公告/.test(name)) return detail?.titleSelector || ''
    if (/内容|正文|详情|描述|摘要/.test(name)) return detail?.blocks?.[0]?.selector || ''
    return ''
  }

  const mapped = {}
  for (const name of fields) mapped[name] = pickFieldSelector(name)

  return {
    url: page.url,
    selector: bestList ? bestList.selector : '',
    followDetail: !!detail,
    fields: mapped,
    listFields: null,
    note: '按页面结构摘要自动生成（AI 未覆盖该站点）'
  }
}

/**
 * 把摘要压缩成给 AI 看的精简结构，避免 token 浪费
 */
function buildDigestPayload (sites) {
  return sites.slice(0, 8).map((site) => ({
    入口: site.url,
    来源: site.source,
    页面标题: truncate(site.title, 60),
    候选列表页: (site.listPages || []).slice(0, 3).map((page) => ({
      url: page.url,
      类型: page.kind || '入口页',
      标题: truncate(page.title, 60),
      可用的列表项选择器: (page.lists || [])
        .slice()
        .sort((a, b) => Number(!!b.relevant) - Number(!!a.relevant) || (b.score || 0) - (a.score || 0))
        .slice(0, 6)
        .map((l) => ({
          selector: l.selector,
          主题相关: l.relevant === false ? '否（选出来的条目与主题无关，不要用）' : '是',
          命中条数: l.count,
          含链接: l.hasLink,
          样例: truncate(l.sample, 70),
          条目链接样例: (l.itemLinks || []).slice(0, 3).map((i) => truncate(i.href, 120))
        })),
      链接文字样例: (page.linkSamples || []).slice(0, 18),
      页面正文开头: truncate(page.text, 260)
    })),
    详情页样本: site.sampleDetail
      ? {
          url: site.sampleDetail.url,
          标题: truncate(site.sampleDetail.title, 80),
          标题选择器: site.sampleDetail.titleSelector || '',
          日期选择器候选: (site.sampleDetail.dates || []).slice(0, 5),
          正文容器候选: (site.sampleDetail.blocks || []).slice(0, 6).map((b) => ({
            selector: b.selector,
            文本长度: b.length,
            链接占比: b.linkDensity,
            开头: truncate(b.text, 160)
          })),
          正文开头: truncate(site.sampleDetail.text, 360)
        }
      : null
  }))
}

/**
 * 保证字段名与用户模板完全对齐
 */
function normalizeFieldMap (fieldMap, wanted) {
  const source = (fieldMap && typeof fieldMap === 'object') ? fieldMap : {}
  const keys = Object.keys(source)
  const out = {}

  const list = wanted.length ? wanted : keys
  for (const name of list) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      out[name] = source[name]
      continue
    }
    // AI 可能改写了字段名，做一次包含匹配兜底
    const hit = keys.find((k) => k.includes(name) || name.includes(k))
    out[name] = hit ? source[hit] : ''
  }
  return out
}

// ============ 职责四：结果清洗 ============

const BATCH_SIZE = 15

/**
 * 结果清洗：过滤不相关、检查字段完整性、标记缺失字段的记录。
 * 只把"提取后的结构化数据"发给 AI（不发原始 HTML、也不发页面正文），省 token。
 * @param {{fields:string[], rows:Array, rules:string, dateRange?:object}} payload
 * @returns {Promise<{rows:Array, issues:string[], summary:string}>}
 */
export async function validateRows (payload) {
  const fields = (payload.fields || []).filter(Boolean)
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  if (!rows.length) return { rows: [], issues: [], summary: '没有可校验的数据' }

  const limit = Number(config.MAX_AI_ROWS) || 120
  const target = rows.slice(0, limit)
  const rest = rows.slice(limit)

  const merged = []
  const issues = []
  const summaries = []

  for (let i = 0; i < target.length; i += BATCH_SIZE) {
    const batch = target.slice(i, i + BATCH_SIZE)
    const range = describeRange(payload)
    const body = {
      主题: payload.topic || '（未提供）',
      主题核心词: (payload.topicKeywords || []).join('、') || '（未提供）',
      字段: describeFields(payload),
      自定义规则: payload.rules ? payload.rules : '无',
      爬取时间段: range ? `${range}（用户明确选的区间，优先于规则里的时间描述）` : '未指定',
      待校验数据: batch.map((row, idx) => {
        const item = { 序号: i + idx + 1 }
        for (const f of fields) item[f] = truncate(row[f], 600)
        return item
      })
    }

    let result
    try {
      result = await chatJSON(VALIDATE_SYSTEM_PROMPT, JSON.stringify(body))
    } catch (err) {
      // 单批失败不影响其他批次
      issues.push(`第 ${i + 1}-${i + batch.length} 条校验失败：${err.message}`)
      merged.push(...batch)
      continue
    }

    const fixed = Array.isArray(result?.rows) ? result.rows : []
    batch.forEach((origin, idx) => {
      const row = fixed[idx]
      const out = {}
      for (const f of fields) {
        const val = row && row[f] != null ? String(row[f]).trim() : ''
        out[f] = val || String(origin[f] ?? '').trim()
      }
      // 保留内部字段（来源链接等）
      if (origin.__source) out.__source = origin.__source
      merged.push(out)
    })

    if (Array.isArray(result?.issues)) issues.push(...result.issues.map(String))
    if (result?.summary) summaries.push(String(result.summary))
  }

  // 超出上限的行直接保留原样
  merged.push(...rest)

  if (rest.length) {
    issues.push(`共有 ${rest.length} 条数据超出 AI 校验上限（${limit} 条），已按原样保留`)
  }

  return {
    rows: dedupe(merged, fields),
    issues,
    summary: summaries.join(' ')
  }
}

function dedupe (rows, fields) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const key = fields.map((f) => String(row[f] ?? '').trim()).join('|')
    if (!key.replace(/\|/g, '').trim()) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}
