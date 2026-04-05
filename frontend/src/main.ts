import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import Lobby from './views/Lobby.vue'
import GameView from './views/GameView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: Lobby },
    { path: '/game', component: GameView },
  ],
})

createApp(App).use(router).mount('#app')
