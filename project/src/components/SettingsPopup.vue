<script setup>
import { ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  config: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['update:modelValue', 'saved'])

const apiBaseUrl = ref('https://api.deepseek.com')
const apiKey = ref('')
const model = ref('deepseek-chat')
// 必须"测试通过"才能保存 —— 这样"配置存在"就等于"已经验证过"
const tested = ref(false)
const testing = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    apiBaseUrl.value = String(props.config?.apiBaseUrl || 'https://api.deepseek.com')
    model.value = String(props.config?.model || 'deepseek-chat')
    // 不回显密钥明文，留空表示"沿用已保存的"
    apiKey.value = ''
    tested.value = !!props.config?.hasApiKey
  }
)

function onEdit () {
  tested.value = false
}

function close () {
  emit('update:modelValue', false)
}

async function test () {
  if (testing.value) return
  testing.value = true
  try {
    const res = await window.crawlerAPI.testSettings({
      apiBaseUrl: apiBaseUrl.value.trim(),
      // 留空时交给主进程用"已保存的密钥"去测
      apiKey: apiKey.value.trim() || undefined,
      model: model.value.trim()
    })
    if (!res?.ok) throw new Error(res?.error || '测试失败')
    tested.value = true
    showSuccessToast('测试成功')
  } catch (err) {
    tested.value = false
    showFailToast(`测试失败：${err.message}`)
  } finally {
    testing.value = false
  }
}

async function save () {
  if (!tested.value) return showToast('请先点「测试」并通过')
  if (!apiKey.value.trim() && !props.config?.hasApiKey) return showToast('请填写 API 密钥')

  try {
    const res = await window.crawlerAPI.saveSettings({
      apiBaseUrl: apiBaseUrl.value.trim(),
      apiKey: apiKey.value.trim() || undefined,
      model: model.value.trim()
    })
    if (!res?.ok) throw new Error(res?.error || '保存失败')
    showSuccessToast('设置已保存')
    emit('saved', res.data)
    close()
  } catch (err) {
    showFailToast(`保存失败：${err.message}`)
  }
}
</script>

<template>
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :style="{ height: 'auto', maxHeight: '80%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="popup">
      <div class="popup-head">
        <span class="title">设置 · AI 接口</span>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <van-icon name="cross" size="18" color="#6b7076" />
        </button>
      </div>

      <div class="popup-body">
        <div class="form-row">
          <label>接口地址</label>
          <input
            v-model="apiBaseUrl"
            class="cell"
            type="text"
            placeholder="https://api.deepseek.com"
            @input="onEdit"
          />
        </div>

        <div class="form-row">
          <label>API 密钥</label>
          <input
            v-model="apiKey"
            class="cell"
            type="password"
            :placeholder="config?.hasApiKey ? `已配置（${config.apiKeyMask}），留空表示不改` : 'sk-...'"
            @input="onEdit"
          />
        </div>

        <div class="form-row">
          <label>模型</label>
          <input v-model="model" class="cell" type="text" placeholder="deepseek-chat" @input="onEdit" />
        </div>

        <p class="tip">
          密钥保存在本机用户目录（不随安装包分发、不会上传）。<b>必须先测试通过才能保存</b>，保存成功后
          「爬取方案」和「开始爬取」才可以使用。
        </p>
        <p v-if="tested" class="state ok">当前状态：测试通过 ✓</p>
        <p v-else class="state warn">当前状态：未通过测试</p>
      </div>

      <div class="popup-foot">
        <van-button plain size="small" :loading="testing" @click="test">
          {{ testing ? '测试中…' : '测试连接' }}
        </van-button>
        <div class="spacer" />
        <van-button plain size="small" @click="close">取消</van-button>
        <van-button plain type="primary" size="small" :disabled="!tested" @click="save">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.popup {
  display: flex;
  flex-direction: column;
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

.popup-body {
  padding: 4px 18px 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.form-row label {
  flex: none;
  width: 76px;
  color: var(--text-2);
  font-size: 13px;
}

.cell {
  flex: 1;
  min-width: 0;
  height: 36px;
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

.tip {
  margin: 6px 0 4px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.7;
}

.state {
  margin: 0;
  font-size: 12px;
}

.ok {
  color: #07c160;
}

.warn {
  color: #ed6a0c;
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
