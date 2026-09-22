<script setup>
import { ref, watch } from 'vue'
import { showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  keywords: { type: Array, default: () => [] },
  plan: { type: Array, default: () => [] },
  selected: { type: Array, default: () => [] },
  // 正在请求 AI 规划：此时锁住弹窗，不让用户做别的操作
  planning: { type: Boolean, default: false },
  hasPlan: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'save', 'plan'])

const rows = ref([])

function buildRows () {
  const planMap = new Map((props.plan || []).map((p) => [String(p?.keyword || ''), p]))
  const picked = new Set((props.selected || []).map((k) => String(k)))
  rows.value = (props.keywords || []).map((keyword) => {
    const item = planMap.get(keyword) || {}
    return {
      keyword,
      checked: picked.size ? picked.has(keyword) : true,
      searchType: item.searchType === 'content' ? '正文' : '标题',
      dateRange: item.dateRange || '不限',
      maxPages: Number(item.maxPages) || 3
    }
  })
}

watch(
  () => [props.modelValue, props.keywords, props.plan],
  () => {
    if (props.modelValue) buildRows()
  }
)

function close () {
  if (props.planning) return showToast('正在规划，请稍候…')
  emit('update:modelValue', false)
}

function removeRow (index) {
  rows.value.splice(index, 1)
}

function toggleAll (checked) {
  rows.value.forEach((row) => {
    row.checked = checked
  })
}

function save () {
  const picked = rows.value.filter((r) => r.checked && String(r.keyword || '').trim())
  if (!picked.length) return showToast('至少勾选一个关键词')

  emit(
    'save',
    {
      keywords: picked.map((r) => String(r.keyword).trim()),
      // 翻页数允许用户在弹窗里改，抓取时按改后的值执行
      plan: picked.map((r) => ({
        keyword: String(r.keyword).trim(),
        searchType: r.searchType === '正文' ? 'content' : 'title',
        dateRange: r.dateRange,
        maxPages: Math.min(Math.max(Number(r.maxPages) || 3, 1), 10)
      }))
    }
  )
  close()
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: '76%' }"
    :close-on-click-overlay="!planning"
    @update:show="!planning && emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">爬取方案</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <!-- 还没规划：先点开始规划 -->
      <div v-if="!hasPlan" class="empty-area">
        <van-empty image-size="70" description="还没有爬取方案">
          <div class="empty-tip">
            点下面的「开始规划」，AI 会结合你的主题、规则、字段和爬取时间段，
            把主题扩展成 8~15 个关键词，并给出每个关键词的搜索方式与翻页计划。
          </div>
        </van-empty>
      </div>

      <template v-else>
        <div class="popup-tools">
          <van-button plain size="small" :disabled="planning" @click="toggleAll(true)">全选</van-button>
          <van-button plain size="small" :disabled="planning" @click="toggleAll(false)">全不选</van-button>
          <span class="tip">
            勾选的关键词都会单独搜索并按各自页数翻页；翻页数可以直接改（1~10 页）。
          </span>
        </div>

        <div class="popup-body">
          <div v-for="(row, i) in rows" :key="row.keyword + i" class="row">
            <label class="pick">
              <input v-model="row.checked" type="checkbox" :disabled="planning" />
            </label>
            <input v-model="row.keyword" class="cell name" type="text" :disabled="planning" />
            <span class="meta">{{ row.searchType }}</span>
            <span class="meta wide">{{ row.dateRange }}</span>
            <input
              v-model="row.maxPages"
              class="cell pages"
              type="number"
              min="1"
              max="10"
              :disabled="planning"
            />
            <span class="meta">页</span>
            <button
              type="button"
              class="row-del"
              aria-label="删除这个关键词"
              :disabled="planning"
              @click="removeRow(i)"
            >
              <van-icon name="cross" size="16" />
            </button>
          </div>

          <p class="foot-note">
            搜索方式（标题/正文）是 AI 的建议，实际以站点自身检索规则为准。
          </p>
        </div>
      </template>

      <!-- 规划中：锁住整个弹窗 -->
      <div v-if="planning" class="mask">
        <van-loading size="20" vertical>AI 正在规划爬取方案，请稍候…</van-loading>
      </div>

      <div class="popup-foot">
        <van-button
          v-if="!hasPlan"
          plain
          type="primary"
          size="small"
          block
          :loading="planning"
          @click="emit('plan')"
        >
          {{ planning ? '规划中…' : '开始规划' }}
        </van-button>

        <template v-else>
          <van-button plain size="small" :disabled="planning" @click="emit('plan')">
            重新规划
          </van-button>
          <div class="spacer" />
          <van-button plain size="small" :disabled="planning" @click="close">取消</van-button>
          <van-button plain type="primary" size="small" :disabled="planning" @click="save">
            保存
          </van-button>
        </template>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.popup {
  position: relative;
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

.empty-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-tip {
  max-width: 300px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.8;
  text-align: left;
}

.popup-tools {
  display: flex;
  align-items: center;
  gap: 8px;
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

.pick {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.cell {
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

.cell:focus {
  border-color: var(--brand);
}

.name {
  flex: 1;
  min-width: 0;
}

.pages {
  width: 56px;
  flex: none;
  text-align: center;
}

.meta {
  flex: none;
  color: var(--text-3);
  font-size: 12px;
}

.wide {
  min-width: 104px;
}

.foot-note {
  margin: 10px 0 0;
  color: var(--text-3);
  font-size: 12px;
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

.mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.78);
}

.popup-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}

.spacer {
  flex: 1;
}
</style>
