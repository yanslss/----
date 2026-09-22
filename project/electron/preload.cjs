const { contextBridge, ipcRenderer } = require('electron')

// 渲染进程可用的安全接口（contextIsolation 打开，不暴露 Node）
contextBridge.exposeInMainWorld('crawlerAPI', {
  // 站点调研：AI 推荐站点 + 搜索引擎发现 + 采集页面结构（结果缓存在主进程，供规划使用）
  analyzeSites: (payload) => ipcRenderer.invoke('site:analyze', payload),

  // AI：搜索规划（主题 → 8~15 个扩展关键词 + 每个词的搜索计划）
  searchPlan: (payload) => ipcRenderer.invoke('ai:searchPlan', payload),
  // AI：规划阶段
  aiPlan: (payload) => ipcRenderer.invoke('ai:plan', payload),
  // AI：校验阶段
  aiValidate: (payload) => ipcRenderer.invoke('ai:validate', payload),

  // 爬虫：按计划抓取
  crawlStart: (payload) => ipcRenderer.invoke('crawl:start', payload),
  crawlStop: () => ipcRenderer.invoke('crawl:stop'),

  // 抓取进度订阅，返回取消订阅函数
  onCrawlProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('crawl:progress', handler)
    return () => ipcRenderer.removeListener('crawl:progress', handler)
  },

  // 保存 Excel（渲染进程用 SheetJS 生成文件内容，这里负责弹保存框并写盘）
  saveExcel: (payload) => ipcRenderer.invoke('excel:save', payload),
  // 在资源管理器中显示文件
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),

  // 导入配置：弹选择框把表格读回二进制，解析交给渲染进程的 SheetJS
  openExcel: (payload) => ipcRenderer.invoke('file:openExcel', payload),

  // 读取配置状态（不返回密钥明文）
  getConfig: () => ipcRenderer.invoke('config:get'),
  // 设置：测试连通性 / 保存（API 地址、密钥、模型）
  testSettings: (payload) => ipcRenderer.invoke('settings:test', payload),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload)
})
