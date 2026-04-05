<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const name = ref('')
const error = ref('')

function join() {
  if (!name.value.trim()) {
    error.value = 'Enter your warrior name'
    return
  }
  if (name.value.trim().length < 2) {
    error.value = 'Name must be at least 2 characters'
    return
  }
  sessionStorage.setItem('playerName', name.value.trim())
  router.push('/game')
}
</script>

<template>
  <div class="lobby">
    <div class="lobby-card">
      <div class="logo">
        <span class="logo-blood">BLOOD</span>
        <span class="logo-amp">&amp;</span>
        <span class="logo-blade">BLADE</span>
      </div>
      <p class="subtitle">Multiplayer · Single world · 64 warriors</p>

      <div class="form">
        <input
          v-model="name"
          class="name-input"
          placeholder="Your warrior name…"
          maxlength="20"
          @keyup.enter="join"
        />
        <p v-if="error" class="error">{{ error }}</p>
        <button class="btn-enter" @click="join">ENTER THE BATTLEFIELD</button>
      </div>

      <div class="controls-hint">
        <h3>CONTROLS</h3>
        <div class="hint-grid">
          <span>WASD</span><span>Move</span>
          <span>Mouse</span><span>Look around</span>
          <span>Left click</span><span>Attack (hold to aim direction)</span>
          <span>Right click</span><span>Block</span>
          <span>ESC</span><span>Release cursor</span>
        </div>
        <p class="hint-note">Where you click on screen determines the attack / block direction</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lobby {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse at 50% 60%, rgba(120, 20, 20, 0.4), transparent 60%),
    linear-gradient(180deg, #0c0a08 0%, #1a1208 100%);
}

.lobby-card {
  width: 480px;
  text-align: center;
  padding: 48px 40px;
  background: rgba(10, 8, 6, 0.85);
  border: 1px solid rgba(180, 120, 40, 0.35);
  border-radius: 12px;
  box-shadow: 0 0 60px rgba(180, 40, 0, 0.2);
}

.logo {
  font-size: 52px;
  font-weight: 900;
  letter-spacing: 4px;
  line-height: 1;
  margin-bottom: 10px;
}

.logo-blood { color: #cc2222; text-shadow: 0 0 20px rgba(200, 0, 0, 0.6); }
.logo-amp   { color: #8b6914; margin: 0 6px; font-size: 36px; }
.logo-blade { color: #c8c0b0; text-shadow: 0 0 15px rgba(200, 200, 180, 0.4); }

.subtitle {
  color: #7a6040;
  font-size: 13px;
  letter-spacing: 1px;
  margin-bottom: 36px;
}

.form {
  margin-bottom: 36px;
}

.name-input {
  width: 100%;
  padding: 14px 18px;
  font-size: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(200, 160, 80, 0.4);
  border-radius: 8px;
  color: #e8d5b0;
  outline: none;
  text-align: center;
  letter-spacing: 1px;
  margin-bottom: 12px;
  transition: border-color 0.2s;
}

.name-input:focus {
  border-color: rgba(200, 160, 80, 0.9);
}

.name-input::placeholder {
  color: #5a4830;
}

.error {
  color: #cc4444;
  font-size: 13px;
  margin-bottom: 10px;
}

.btn-enter {
  width: 100%;
  padding: 16px;
  font-size: 14px;
  font-weight: bold;
  letter-spacing: 3px;
  cursor: pointer;
  border: 1px solid #cc2222;
  border-radius: 8px;
  background: linear-gradient(135deg, #8b1010, #cc2222);
  color: #ffeedd;
  transition: all 0.2s;
}

.btn-enter:hover {
  background: linear-gradient(135deg, #aa1515, #ee2222);
  box-shadow: 0 0 20px rgba(200, 30, 30, 0.5);
}

.controls-hint {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 200, 100, 0.1);
  border-radius: 8px;
  padding: 20px;
  text-align: left;
}

.controls-hint h3 {
  font-size: 12px;
  letter-spacing: 2px;
  color: #c8a860;
  margin-bottom: 14px;
  text-align: center;
}

.hint-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  font-size: 13px;
}

.hint-grid span:nth-child(odd) {
  color: #ffcc66;
  font-weight: bold;
  white-space: nowrap;
}

.hint-grid span:nth-child(even) {
  color: #999;
}

.hint-note {
  margin-top: 12px;
  font-size: 11px;
  color: #5a4830;
  font-style: italic;
  text-align: center;
}
</style>
