<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RemotePlayer, GameEvent, SwingPowerTier } from '../types/protocol'

const props = defineProps<{
  localPlayer: RemotePlayer | null
  players: RemotePlayer[]
  events: GameEvent[]
  fps: number
  ping: number
  roundTimeLeft: number
  currentTeam: string
  intendedSwingDir?: string
  isCharging?: boolean
  isAttackCharging?: boolean
}>()

function formatTime(ms: number) {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

const topPlayers = computed(() =>
  [...props.players].sort((a, b) => b.kills - a.kills).slice(0, 8)
)

/** Nombre para el feed de combate (evita UUID largos si ya tenemos el jugador en snapshot). */
function resolvePlayerName(id: string | undefined): string {
  if (!id) return '?'
  const p = props.players.find((x) => x.id === id)
  if (p?.name?.trim()) return p.name.trim()
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

const hpPercent = computed(() => {
  if (!props.localPlayer) return 100
  return (props.localPlayer.health / props.localPlayer.maxHealth) * 100
})

const hpColor = computed(() => {
  const p = hpPercent.value
  if (p > 60) return '#22cc44'
  if (p > 30) return '#ffaa00'
  return '#cc2222'
})

const swingChargePercent = computed(() => {
  if (!props.localPlayer) return 0
  if (props.localPlayer.swingPhase !== 'WINDUP') return 0
  const c = Math.max(0, Math.min(1, props.localPlayer.swingCharge ?? 0))
  return c * 100
})

const swingPowerTier = computed<SwingPowerTier>(() => {
  if (!props.localPlayer) return 'CANCEL'
  return props.localPlayer.swingPowerTier ?? 'CANCEL'
})

const swingPowerText = computed(() => {
  if (!props.isAttackCharging || !props.localPlayer || props.localPlayer.blocking) return ''
  if (props.localPlayer.swingPhase !== 'WINDUP') return ''
  if (swingPowerTier.value === 'FULL') return 'FULL STRIKE'
  if (swingPowerTier.value === 'WEAK') return 'WEAK STRIKE'
  return 'RELEASE NOW = CANCEL'
})

/** Aviso de bloqueo: tú rechazaste el golpe / te rechazaron el golpe */
const blockBanner = ref<'none' | 'you_blocked' | 'got_blocked'>('none')
let blockBannerTimer: ReturnType<typeof setTimeout> | null = null
const showHitMarker = ref(false)
const showKillMessage = ref(false)
let hitMarkerTimer: any = null
let killMessageTimer: any = null

  watch(
    () => props.events,
    (evs) => {
      if (!props.localPlayer || evs.length === 0) return
      // Tomamos el último evento (o podríamos procesar un buffer, pero el último es lo más crítico)
      const ev = evs[evs.length - 1]
      
      let found: 'none' | 'you_blocked' | 'got_blocked' = 'none'

      if (ev.type === 'BLOCK_SUCCESS') {
          if (ev.attackerId === props.localPlayer.id) found = 'you_blocked'
          else if (ev.victimId === props.localPlayer.id) found = 'got_blocked'
      }
      
      if (ev.attackerId === props.localPlayer.id) {
          if (ev.type === 'PLAYER_HIT') {
              showHitMarker.value = true
              if (hitMarkerTimer) clearTimeout(hitMarkerTimer)
              hitMarkerTimer = setTimeout(() => showHitMarker.value = false, 400)
          }
          if (ev.type === 'PLAYER_KILLED') {
              showKillMessage.value = true
              if (killMessageTimer) clearTimeout(killMessageTimer)
              killMessageTimer = setTimeout(() => showKillMessage.value = false, 3000)
          }
      }

      if (found !== 'none') {
        blockBanner.value = found
        if (blockBannerTimer) clearTimeout(blockBannerTimer)
        blockBannerTimer = setTimeout(() => {
          blockBanner.value = 'none'
          blockBannerTimer = null
        }, 2000)
      }
    },
    { deep: true }
  )
</script>

<template>
  <!-- Temporizador de Ronda -->
  <div class="round-timer">
    <div class="timer-value">{{ formatTime(roundTimeLeft) }}</div>
    <div class="timer-label">OBJECTIVE: DESTROY ENEMY BASE</div>
  </div>

  <!-- Barra de vida -->
  <div class="hud-health-container">
    <div class="hp-info">
      <span class="hp-name" :class="currentTeam?.toLowerCase()">
        <span class="team-tag">{{ currentTeam === 'BARBARIAN' ? 'BARBARIAN' : 'KNIGHT' }}</span>
        {{ localPlayer?.name || 'HERO' }}
      </span>
      <span class="hp-values">{{ localPlayer?.health ?? 0 }} / {{ localPlayer?.maxHealth ?? 100 }}</span>
    </div>
    <div class="hp-bar-bg">
      <div class="hp-bar-phantom" :style="{ width: hpPercent + '%' }" />
      <div class="hp-bar-fill" :style="{ width: hpPercent + '%', background: hpColor }" />
    </div>
  </div>

  <!-- Bloqueo exitoso / te bloquearon -->
  <Transition name="fade">
    <div
      v-if="blockBanner !== 'none'"
      class="block-banner"
      :class="blockBanner === 'you_blocked' ? 'block-ok' : 'block-bad'"
    >
      <span v-if="blockBanner === 'you_blocked'" class="block-icon">✓</span>
      <span v-else class="block-icon">✕</span>
      <span class="block-text">
        {{ blockBanner === 'you_blocked' ? 'YOU BLOCKED THE BLOW' : 'THEY BLOCKED YOU' }}
      </span>
    </div>
  </Transition>

  <div class="combat-feedback" v-if="showHitMarker">
    <div class="hit-marker">╳</div>
  </div>
  
  <div class="kill-marker" v-if="showKillMessage">
    <div class="kill-text">FOE ELIMINATED</div>
  </div>

  <div class="death-overlay" v-if="localPlayer && localPlayer.health <= 0">
    <div class="death-msg">YOU ARE DEAD</div>
    <div class="death-sub">Wait for respawn...</div>
  </div>

  <!-- Crosshair -->
  <div class="crosshair">
    <div class="ch-h" />
    <div class="ch-v" />
  </div>

  <!-- Dirección de swing actual -->
  <div class="swing-indicator" v-if="localPlayer">
    <div class="swing-phase" :class="localPlayer.swingPhase.toLowerCase()">
      <template v-if="isCharging">
        {{ localPlayer.blocking ? '🛡 ' : '⚔ ' }}{{ intendedSwingDir }}
      </template>
      <template v-else>
        {{ localPlayer.blocking ? '🛡 ' + localPlayer.blockDir : '⚔ ' + localPlayer.swingDir }}
      </template>
    </div>
    <div v-if="isAttackCharging && !localPlayer.blocking && localPlayer.swingPhase === 'WINDUP'" class="charge-hint" :class="'tier-' + swingPowerTier.toLowerCase()">
      {{ swingPowerText }}
    </div>
    <div v-if="isAttackCharging && !localPlayer.blocking && localPlayer.swingPhase === 'WINDUP'" class="charge-bar">
      <div class="charge-zone zone-cancel"></div>
      <div class="charge-zone zone-weak"></div>
      <div class="charge-zone zone-full"></div>
      <div class="charge-marker cancel-threshold"></div>
      <div class="charge-marker full-threshold"></div>
      <div class="charge-fill" :style="{ width: swingChargePercent + '%' }" :class="'tier-' + swingPowerTier.toLowerCase()" />
    </div>
  </div>

  <!-- Leaderboard -->
  <div class="leaderboard">
    <div class="lb-title">LEADERBOARD</div>
    <div
      v-for="p in topPlayers"
      :key="p.id"
      class="lb-row"
      :class="{ 'lb-self': p.id === localPlayer?.id }"
    >
      <span class="lb-name">{{ p.name }}</span>
      <span class="lb-kills">{{ p.kills }}</span>
    </div>
  </div>

  <!-- Feed de eventos -->
  <div class="event-feed">
    <TransitionGroup name="ev">
      <div v-for="(ev, i) in events.slice(-5)" :key="i" class="ev-item">
        <template v-if="ev.type === 'PLAYER_KILLED'">
          <span class="ev-name-win">{{ resolvePlayerName(ev.attackerId) }}</span>
          <span class="ev-sep"> ⚔ </span>
          <span class="ev-name-lose">{{ resolvePlayerName(ev.victimId) }}</span>
        </template>
        <template v-else-if="ev.type === 'PLAYER_HIT'">
          <span class="ev-name-win">{{ resolvePlayerName(ev.attackerId) }}</span>
          <span class="ev-sep"> ➔ </span>
          <span class="ev-name-lose">{{ resolvePlayerName(ev.victimId) }}</span>
        </template>
        <template v-else-if="ev.type === 'BLOCK_SUCCESS'">
          <span class="ev-name-win">{{ resolvePlayerName(ev.attackerId) }}</span>
          <span class="ev-sep"> 🛡 </span>
          <span class="ev-name-win">{{ resolvePlayerName(ev.victimId) }}</span>
        </template>
      </div>
    </TransitionGroup>
  </div>

  <!-- Stats esquina -->
  <div class="corner-stats">
    <div>FPS {{ fps }}</div>
    <div>PING {{ ping }}ms</div>
    <div v-if="localPlayer">K {{ localPlayer.kills }} / D {{ localPlayer.deaths }}</div>
  </div>
</template>

<style scoped>
/* ── Globales / Tipografía ───────────────────────────────── */
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;600;900&display=swap');

* {
  font-family: 'Outfit', sans-serif;
}

/* ── Temporizador ────────────────────────────────────────── */
.round-timer {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  z-index: 10;
  pointer-events: none;
}

.timer-value {
  font-size: 38px;
  font-weight: 900;
  letter-spacing: 4px;
  color: #fff;
  text-shadow: 0 0 20px rgba(0,0,0,0.8);
}

.timer-label {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #c8a860;
  margin-top: -4px;
  opacity: 0.8;
}

/* ── Barra de vida ─────────────────────────────────────── */
.hud-health-container {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  width: 480px;
  filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5));
}

.hp-info {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 6px;
  padding: 0 4px;
}

.hp-name {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 3px;
  color: #fff;
  text-transform: uppercase;
  display: flex;
  flex-direction: column;
}

.team-tag {
  font-size: 9px;
  letter-spacing: 2px;
  margin-bottom: 2px;
  opacity: 0.7;
}

.hp-name.barbarian { color: #ff8833; }
.hp-name.knight { color: #44aaff; }

.hp-values {
  font-size: 14px;
  font-weight: 300;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 1px;
}

.hp-bar-bg {
  position: relative;
  width: 100%;
  height: 10px;
  background: rgba(20, 20, 25, 0.8);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  overflow: hidden;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.4);
}

.hp-bar-fill {
  position: absolute;
  top: 0; left: 0;
  height: 100%;
  transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1), background 0.6s ease;
  z-index: 2;
  box-shadow: 0 0 15px currentColor;
}

.hp-bar-phantom {
  position: absolute;
  top: 0; left: 0;
  height: 100%;
  background: rgba(255, 255, 255, 0.25);
  transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 1;
}

/* ── Aviso de bloqueo ───────────────────────────────────── */
.block-banner {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 20px 40px;
  border-radius: 2px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 5px;
  text-transform: uppercase;
  color: #fff;
  pointer-events: none;
  z-index: 10;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
}

.block-banner.block-ok {
  border-top: 1px solid rgba(0, 255, 120, 0.4);
  border-bottom: 1px solid rgba(0, 255, 120, 0.4);
  color: #a0ffd0;
}

.block-banner.block-bad {
  border-top: 1px solid rgba(255, 50, 50, 0.4);
  border-bottom: 1px solid rgba(255, 50, 50, 0.4);
  color: #ffb0b0;
}

.block-icon {
  font-size: 24px;
  margin-bottom: 2px;
}

/* ── Crosshair ──────────────────────────────────────────── */
.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 4px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 0 6px #fff;
  opacity: 0.6;
  pointer-events: none;
}

/* ── Indicador de swing ─────────────────────────────────── */
.swing-indicator {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, 60px);
  text-align: center;
  width: 180px;
}

.swing-phase {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 3px;
  text-transform: uppercase;
  margin-bottom: 8px;
  opacity: 0.9;
}

.swing-phase.release { color: #ff5030; text-shadow: 0 0 10px rgba(255,80,48,0.5); }
.swing-phase.windup  { color: #ffaa33; text-shadow: 0 0 8px rgba(255,170,51,0.4); }
.swing-phase.blocked { color: #50a0ff; }
.swing-phase.idle    { color: #ffffff; }

.charge-hint {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 2px;
  margin-bottom: 6px;
  text-transform: uppercase;
}

.charge-hint.tier-cancel { color: #ff6f5e; }
.charge-hint.tier-weak { color: #ffd35e; }
.charge-hint.tier-full { color: #88ff9a; }

.charge-bar {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.15);
  overflow: hidden;
}

.charge-zone {
  position: absolute;
  top: 0;
  bottom: 0;
}

.zone-cancel {
  left: 0;
  width: 70%;
  background: rgba(255, 66, 66, 0.25);
}

.zone-weak {
  left: 70%;
  width: 29%;
  background: rgba(255, 181, 66, 0.3);
}

.zone-full {
  left: 99%;
  width: 1%;
  background: rgba(120, 255, 140, 0.45);
}

.charge-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  transition: width 0.05s linear;
}

.charge-fill.tier-cancel {
  background: linear-gradient(90deg, #ff5252, #ff8b7e);
  box-shadow: 0 0 8px rgba(255, 90, 90, 0.7);
}

.charge-fill.tier-weak {
  background: linear-gradient(90deg, #ffb347, #ffd95e);
  box-shadow: 0 0 10px rgba(255, 205, 90, 0.75);
}

.charge-fill.tier-full {
  background: linear-gradient(90deg, #8fff94, #c7ff97);
  box-shadow: 0 0 12px rgba(135, 255, 145, 0.8);
}

.charge-marker {
  position: absolute;
  top: -1px;
  bottom: -1px;
  width: 2px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
}

.cancel-threshold { left: 70%; }
.full-threshold { left: 99%; }

/* ── Leaderboard ────────────────────────────────────────── */
.leaderboard {
  position: absolute;
  top: 40px;
  right: 40px;
  background: rgba(10, 12, 18, 0.4);
  backdrop-filter: blur(12px);
  border-left: 2px solid rgba(200, 160, 100, 0.4);
  padding: 16px 20px;
  min-width: 220px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.4);
}

.lb-title {
  font-weight: 900;
  font-size: 10px;
  letter-spacing: 4px;
  color: #c8a860;
  margin-bottom: 15px;
  text-transform: uppercase;
}

.lb-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  font-size: 13px;
  letter-spacing: 0.5px;
}

.lb-self { color: #ffdd88; font-weight: 600; }
.lb-kills { font-weight: 900; }

/* ── Event feed ─────────────────────────────────────────── */
.event-feed {
  position: absolute;
  top: 40px;
  left: 40px;
  pointer-events: none;
}

.ev-item {
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  animation: evIn 0.3s ease-out forwards;
}

@keyframes evIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}

.ev-name-win { color: #fff; }
.ev-name-lose { color: rgba(255, 255, 255, 0.4); }
.ev-sep { color: #c8a860; margin: 0 8px; }

/* ── Esquina stats ──────────────────────────────────────── */
.corner-stats {
  position: absolute;
  bottom: 40px;
  right: 40px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.3);
  text-transform: uppercase;
  display: flex;
  gap: 20px;
  pointer-events: none;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.5s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── Combat Feedback / Markers ───────────────────────────── */
.combat-feedback {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 100;
}

.hit-marker {
  font-size: 32px;
  color: #fff;
  font-weight: 300;
  text-shadow: 0 0 10px rgba(255,255,255,0.8);
  animation: hitIn 0.1s ease-out;
}

@keyframes hitIn {
  from { transform: scale(0.5); opacity: 0; }
  to { transform: scale(1.2); opacity: 1; }
}

.kill-marker {
  position: absolute;
  top: 30%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 101;
  text-align: center;
}

.kill-text {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: 8px;
  color: #ffdd44;
  text-shadow: 0 0 20px rgba(255, 200, 0, 0.6);
  animation: killIn 0.4s cubic-bezier(0.17, 0.89, 0.32, 1.49);
}

@keyframes killIn {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.death-overlay {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background: radial-gradient(circle, rgba(60, 0, 0, 0.4) 0%, rgba(0,0,0,0.85) 100%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  z-index: 200;
  backdrop-filter: grayscale(1) blur(4px);
  animation: deathFade 1s ease-out forwards;
}

@keyframes deathFade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.death-msg {
  font-size: 64px;
  font-weight: 900;
  letter-spacing: 12px;
  color: #ff2222;
  text-shadow: 0 0 30px rgba(255, 0, 0, 0.5);
  margin-bottom: 10px;
}

.death-sub {
  font-size: 14px;
  letter-spacing: 4px;
  color: #fff;
  opacity: 0.6;
  text-transform: uppercase;
}
</style>
