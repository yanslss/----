import { createApp } from 'vue'
import {
  Button,
  Calendar,
  Collapse,
  CollapseItem,
  Empty,
  Field,
  Icon,
  Loading,
  Popup,
  Progress,
  Switch,
  Tag
} from 'vant'
import 'vant/lib/index.css'

import './style.css'
import App from './App.vue'

const app = createApp(App)

;[
  Button,
  Calendar,
  Collapse,
  CollapseItem,
  Empty,
  Field,
  Icon,
  Loading,
  Popup,
  Progress,
  Switch,
  Tag
].forEach((component) => {
  app.use(component)
})

app.mount('#app')
