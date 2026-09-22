<script setup>
import { ref, watch } from 'vue'
import { showFailToast, showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  sites: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'save'])

const rows = ref([])

// 每次打开时按外部数据重建编辑区
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    rows.value = (props.sites || []).map((s) => ({
      site: String(s?.site || ''),
      username: String(s?.username || ''),
      password: String(s?.password || '')
    }))
  }
)

function close () {
  emit('update:modelValue', false)
}

function addRow () {
  rows.value.push({ site: '', username: '', password: '' })
}

function removeRow (index) {
  rows.value.splice(index, 1)
}

// 网站统一成域名，方便和登录页的地址做匹配：
// 用户填 https://www.example.com/login 或 www.example.com 都能存成 example.com
function normalizeSite (value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./i, '')
    .toLowerCase()
}

function blurSite (row) {
  row.site = normalizeSite(row.site)
}

function save () {
  const list = []

  for (let i = 0; i < rows.value.length; i++) {
    const site = normalizeSite(rows.value[i].site)
    const username = String(rows.value[i].username || '').trim()
    const password = String(rows.value[i].password || '')

    // 整行都空则忽略
    if (!site && !username && !password) continue
    if (!site) {
      showFailToast(`第 ${i + 1} 行：网站没填`)
      return
    }
    if (!username) {
      showFailToast(`第 ${i + 1} 行：账号名没填`)
      return
    }
    list.push({ site, username, password })
  }

  emit('save', list)
  showToast(list.length ? `已保存 ${list.length} 个站点账号` : '密码本已清空')
  close()
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: '70%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">密码本</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <div class="popup-tools">
        <van-button plain size="small" icon="plus" @click="addRow">新建</van-button>
        <span class="tip">
          网站填域名即可（可不带 http://）。爬取时一旦遇到需要登录的页面，会先按域名匹配这里，命中就自动填账号密码。
        </span>
      </div>

      <div class="popup-body">
        <div v-if="!rows.length" class="empty">
          <van-empty image-size="60" description="还没有账号，点上方「新建」添加一条" />
        </div>

        <div v-for="(row, i) in rows" :key="i" class="row">
          <input
            v-model="row.site"
            class="cell site"
            type="text"
            placeholder="网站，如 example.com"
            @blur="blurSite(row)"
          />
          <input v-model="row.username" class="cell" type="text" placeholder="账号名（用户名）" />
          <input v-model="row.password" class="cell" type="password" placeholder="密码" />
          <button type="button" class="row-del" aria-label="删除这一行" @click="removeRow(i)">
            <van-icon name="cross" size="16" />
          </button>
        </div>
      </div>

      <div class="popup-foot">
        <van-button plain size="small" @click="close">取消</van-button>
        <van-button plain type="primary" size="small" @click="save">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.popup {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.popup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  line-height: 0;
}

.close-btn:hover {
  background: #f2f3f5;
}

.close-btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.popup-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px 10px;
}

.tip {
  flex: 1;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}

.popup-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 18px 12px;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafbfc;
}

.row + .row {
  margin-top: 10px;
}

.cell {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid #d5d9df;
  border-radius: 6px;
  background: #fff;
  color: var(--text-1);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}

.cell::placeholder {
  color: #6f747c;
}

.cell:focus {
  border-color: var(--brand);
}

.site {
  flex: 1.3;
}

.row-del {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.row-del:hover {
  background: #ffece8;
  color: #ee0a24;
}

.row-del:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.popup-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
</style>
