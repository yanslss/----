<script setup>
import { ref, watch } from 'vue'
import { showFailToast, showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  links: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'save'])

const rows = ref([])

// 每次打开时按外部数据重建编辑区
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    rows.value = (props.links || []).map((url) => ({ url: String(url || '') }))
  }
)

function close () {
  emit('update:modelValue', false)
}

function addRow () {
  rows.value.push({ url: '' })
}

function removeRow (index) {
  rows.value.splice(index, 1)
}

// 允许用户不写 http，自动补成 https://
function normalizeUrl (value) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return `https:${s}`
  return `https://${s}`
}

function blurUrl (row) {
  row.url = normalizeUrl(row.url)
}

function save () {
  const list = []

  for (let i = 0; i < rows.value.length; i++) {
    const url = normalizeUrl(rows.value[i].url)
    if (!url) continue

    try {
      const parsed = new URL(url)
      if (!parsed.hostname.includes('.')) throw new Error('host')
    } catch (_) {
      showFailToast(`第 ${i + 1} 行：链接格式不对（${rows.value[i].url}）`)
      return
    }

    if (!list.includes(url)) list.push(url)
  }

  emit('save', list)
  showToast(list.length ? `已保存 ${list.length} 个链接` : '链接已清空')
  close()
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: '66%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">推荐链接</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <div class="popup-tools">
        <van-button plain size="small" icon="plus" @click="addRow">新建</van-button>
        <span class="tip">
          一行一个起始网址，可以不写 http://（保存时会自动补上）。既可以是列表页，也可以是单个详情页。
        </span>
      </div>

      <div class="popup-body">
        <div v-if="!rows.length" class="empty">
          <van-empty image-size="60" description="还没有链接，点上方「新建」添加一条" />
        </div>

        <div v-for="(row, i) in rows" :key="i" class="row">
          <input
            v-model="row.url"
            class="cell"
            type="text"
            placeholder="链接，如 www.example.com/zbgg/index.html"
            @blur="blurUrl(row)"
          />
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
