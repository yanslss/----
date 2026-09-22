<script setup>
import { computed } from 'vue'

const props = defineProps({
  fields: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] }
})

const total = computed(() => props.rows.length)
</script>

<template>
  <div class="result">
    <div v-if="!total" class="result-empty">
      <van-empty image-size="72" description="暂无抓取结果" />
    </div>

    <div v-else class="table-scroll">
      <table class="preview">
        <thead>
          <tr>
            <th class="col-idx">#</th>
            <th v-for="f in fields" :key="f">{{ f }}</th>
            <th class="col-src">来源链接</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td class="col-idx">{{ i + 1 }}</td>
            <td v-for="f in fields" :key="f" :title="String(row[f] ?? '')">
              {{ row[f] }}
            </td>
            <td class="col-src">
              <a v-if="row.__source" :href="row.__source" target="_blank" rel="noreferrer">
                {{ row.__source.replace(/^https?:\/\//, '').slice(0, 40) }}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.result {
  height: 100%;
  min-height: 0;
}

.result-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.table-scroll {
  height: 100%;
  overflow: auto;
}

.preview {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  table-layout: fixed;
}

.preview th,
.preview td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
}

.preview thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #fafbfc;
  color: var(--text-2);
  font-weight: 600;
  white-space: nowrap;
}

.preview tbody tr:hover td {
  background: #f7fafd;
}

.preview td {
  max-width: 0;
  overflow: hidden;
  color: var(--text-1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-idx {
  width: 48px;
  color: var(--text-3);
  text-align: center !important;
}

.col-src {
  width: 200px;
}

.col-src a {
  color: var(--brand);
  text-decoration: none;
  word-break: break-all;
}
</style>
