<script setup>
import { ref, watch } from 'vue'
import { showFailToast, showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  fields: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'save'])

// 常见数据类型：类型本身不参与抓取，但会随字段一起告诉 AI，
// 并在导出 Excel 时对"数字/金额"做一次数值化（方便在表格里排序、求和）
const TYPES = ['文本', '数字', '日期', '时间', '金额', '百分比', '链接', '其他']

const rows = ref([])

// 每次打开时按外部数据重建编辑区
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    rows.value = (props.fields || []).map((f) => ({
      name: String(f?.name || ''),
      type: TYPES.includes(String(f?.type)) ? String(f.type) : '文本',
      note: String(f?.note || '')
    }))
  }
)

function close () {
  emit('update:modelValue', false)
}

function addRow () {
  rows.value.push({ name: '', type: '文本', note: '' })
}

function removeRow (index) {
  rows.value.splice(index, 1)
}

function save () {
  const list = []
  const seen = new Set()

  for (let i = 0; i < rows.value.length; i++) {
    const name = String(rows.value[i].name || '').trim()
    const type = String(rows.value[i].type || '文本')
    const note = String(rows.value[i].note || '').trim()

    // 整行都空则忽略
    if (!name && !note) continue
    if (!name) {
      showFailToast(`第 ${i + 1} 行：字段名没填`)
      return
    }
    if (seen.has(name)) {
      showFailToast(`字段名重复：${name}`)
      return
    }
    seen.add(name)
    list.push({ name, type, note })
  }

  emit('save', list)
  showToast(list.length ? `已保存 ${list.length} 个字段` : '字段已清空')
  close()
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: '72%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">编辑爬取内容</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <div class="popup-tools">
        <van-button plain size="small" icon="plus" @click="addRow">新建</van-button>
        <span class="tip">
          这里定义"要抓哪些内容"：字段名写你想在表格里看到的列名，数据类型和备注会一起告诉 AI，帮它找准位置。
        </span>
      </div>

      <div class="popup-body">
        <div v-if="!rows.length" class="empty">
          <van-empty image-size="60" description="还没有字段，点上方「新建」添加一行" />
        </div>

        <div v-for="(row, i) in rows" :key="i" class="row">
          <input v-model="row.name" class="cell name" type="text" placeholder="字段名，如 发布日期" />
          <select v-model="row.type" class="cell type">
            <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-model="row.note" class="cell" type="text" placeholder="备注（可选），如 公告发布当天" />
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
  flex: 1.2;
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

.name {
  flex: 1;
}

.type {
  flex: none;
  width: 82px;
  cursor: pointer;
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

.popup-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
</style>
