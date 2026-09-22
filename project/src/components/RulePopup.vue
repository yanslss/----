<script setup>
import { ref, watch } from 'vue'
import { showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  rules: { type: String, default: '' },
  fields: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:modelValue', 'save'])

const PRESETS = [
  '只抓近30天发布的内容',
  '只要广东地区',
  '过滤掉中标结果，只要招标公告',
  '每条记录必须包含项目名称和发布日期',
  '公告内容只保留正文，去掉联系方式'
]

const draft = ref('')

// 每次打开时同步外部值
watch(
  () => props.modelValue,
  (open) => {
    if (open) draft.value = props.rules || ''
  }
)

function appendPreset (text) {
  draft.value = draft.value ? `${draft.value.replace(/\s+$/, '')}\n${text}` : text
}

function close () {
  emit('update:modelValue', false)
}

function save () {
  emit('save', draft.value.trim())
  showToast('规则已保存')
  close()
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: '62%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">规则设置</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <div class="popup-body">
        <p class="tip">用自然语言描述抓取要求，AI 会在规划与校验两个阶段都遵守这些规则。</p>

        <div class="chips">
          <button v-for="p in PRESETS" :key="p" type="button" class="chip" @click="appendPreset(p)">
            + {{ p }}
          </button>
        </div>

        <van-field
          v-model="draft"
          type="textarea"
          rows="6"
          autosize
          maxlength="500"
          show-word-limit
          placeholder="例如：只抓近30天、只要广东地区"
        />

        <p v-if="fields.length" class="tip">当前模板字段：{{ fields.join('、') }}</p>
      </div>

      <div class="popup-foot">
        <van-button plain size="small" @click="draft = ''">清空</van-button>
        <van-button plain type="primary" size="small" @click="save">保存规则</van-button>
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

.popup-body {
  flex: 1;
  overflow: auto;
  padding: 0 18px 12px;
}

.tip {
  margin: 0 0 10px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.chip {
  padding: 4px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 14px;
  background: #fff;
  color: var(--text-2);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.chip:focus-visible,
.close-btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
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

.popup-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
</style>
