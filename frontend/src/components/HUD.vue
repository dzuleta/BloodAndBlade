<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RemotePlayer, GameEvent } from '../types/protocol'

const props = defineProps<{
  localPlayer: RemotePlayer | null
  players: RemotePlayer[]
  events: GameEvent[]
  fps: number
  ping: number
}>()

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

/** Aviso de bloqueo: tú rechazaste el golpe / te rechazaron el golpe */
const blockBanner = ref<'none' | 'you_blocked' | 'got_blocked'>('none')
let blockBannerTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.events.length,
  () => {
    const ev = props.events[props.events.length - 1]
    if (!ev || ev.type !== 'BLOCK_SUCCESS' || !props.localPlayer) return
    if (blockBannerTimer) clearTimeout(blockBannerTimer)
    if (ev.attackerId === props.localPlayer.id) {
      blockBanner.value = 'you_blocked'
    } else if (ev.victimId === props.localPlayer.id) {
      blockBanner.value = 'got_blocked'
    } else {
      return
    }
    blockBannerTimer = setTimeout(() => {
      blockBanner.value = 'none'
      blockBannerTimer = null
    }, 1800)
  },
)
</script>

<template>
  <!-- Barra de vida -->
  <div class="hud-health">
    <div class="hp-label">{{ localPlayer?.health ?? 0 }} / {{ localPlayer?.maxHealth ?? 100 }}</div>
    <div class="hp-bar-bg">
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
        {{ blockBanner === 'you_blocked' ? 'Bloqueaste el golpe' : 'Te bloquearon' }}
      </span>
    </div>
  </Transition>

  <!-- Crosshair -->
  <div class="crosshair">
    <div class="ch-h" />
    <div class="ch-v" />
  </div>

  <!-- Dirección de swing actual -->
  <div class="swing-indicator" v-if="localPlayer">
    <div class="swing-phase" :class="localPlayer.swingPhase.toLowerCase()">
      {{ localPlayer.blocking ? '🛡 ' + localPlayer.blockDir : '⚔ ' + localPlayer.swingDir }}
    </div>
    <div class="momentum-bar">
      <div class="momentum-fill" :style="{ width: (localPlayer.momentum * 100) + '%' }" />
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
    <TransitionGroup name="fade">
      <div v-for="(ev, i) in events.slice(-6)" :key="i" class="ev-item">
        <template v-if="ev.type === 'PLAYER_KILLED'">
          <span class="ev-name">{{ resolvePlayerName(ev.attackerId) }}</span>
          <span class="ev-sep"> killed </span>
          <span class="ev-name ev-victim">{{ resolvePlayerName(ev.victimId) }}</span>
        </template>
        <template v-else-if="ev.type === 'PLAYER_HIT'">
          <span class="ev-name">{{ resolvePlayerName(ev.attackerId) }}</span>
          <span class="ev-sep"> hit </span>
          <span class="ev-name ev-victim">{{ resolvePlayerName(ev.victimId) }}</span>
          <span class="ev-sep"> ({{ ev.zone }}) –{{ ev.damage }}</span>
        </template>
        <template v-else>
          <span class="ev-sep">{{ ev.message }}</span>
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
/* ── Barra de vida ─────────────────────────────────────── */
.hud-health {
  position: absolute;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  text-align: center;
}

.hp-label {
  font-size: 14px;
  font-weight: bold;
  margin-bottom: 4px;
  text-shadow: 0 1px 3px #000;
  letter-spacing: 1px;
}

.hp-bar-bg {
  width: 100%;
  height: 14px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 220, 150, 0.3);
  border-radius: 7px;
  overflow: hidden;
}

.hp-bar-fill {
  height: 100%;
  border-radius: 7px;
  transition: width 0.15s ease, background 0.3s ease;
}

/* ── Aviso de bloqueo ───────────────────────────────────── */
.block-banner {
  position: absolute;
  top: 42%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 22px;
  border-radius: 10px;
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 1px;
  text-shadow: 0 2px 6px #000;
  pointer-events: none;
  z-index: 6;
  border: 2px solid rgba(255, 255, 255, 0.35);
}

.block-banner.block-ok {
  background: rgba(20, 90, 40, 0.88);
  color: #c8ffc8;
}

.block-banner.block-bad {
  background: rgba(110, 30, 20, 0.88);
  color: #ffcccc;
}

.block-icon {
  font-size: 22px;
  line-height: 1;
}

.block-text {
  white-space: nowrap;
}

/* ── Crosshair ──────────────────────────────────────────── */
.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.ch-h,
.ch-v {
  position: absolute;
  background: rgba(255, 240, 200, 0.85);
}

.ch-h {
  width: 18px;
  height: 2px;
  top: -1px;
  left: -9px;
}

.ch-v {
  width: 2px;
  height: 18px;
  top: -9px;
  left: -1px;
}

/* ── Indicador de swing ─────────────────────────────────── */
.swing-indicator {
  position: absolute;
  bottom: 70px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  width: 200px;
}

.swing-phase {
  font-size: 13px;
  font-weight: bold;
  letter-spacing: 1px;
  text-shadow: 0 1px 3px #000;
  margin-bottom: 4px;
}

.swing-phase.release { color: #ff6644; }
.swing-phase.windup  { color: #ffaa44; }
.swing-phase.blocked { color: #4488ff; }
.swing-phase.idle    { color: #aaaaaa; }

.momentum-bar {
  width: 100%;
  height: 6px;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 3px;
  overflow: hidden;
}

.momentum-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff8800, #ffdd44);
  border-radius: 3px;
  transition: width 0.05s linear;
}

/* ── Leaderboard ────────────────────────────────────────── */
.leaderboard {
  position: absolute;
  top: 20px;
  right: 20px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 200, 100, 0.25);
  border-radius: 6px;
  padding: 10px 14px;
  min-width: 180px;
  font-size: 13px;
}

.lb-title {
  font-weight: bold;
  font-size: 11px;
  letter-spacing: 2px;
  color: #c8a860;
  margin-bottom: 8px;
  text-align: center;
}

.lb-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
  color: #ddd;
}

.lb-self {
  color: #ffdd88;
  font-weight: bold;
}

.lb-kills {
  color: #ff8844;
  font-weight: bold;
}

/* ── Event feed ─────────────────────────────────────────── */
.event-feed {
  position: absolute;
  bottom: 100px;
  left: 20px;
  font-size: 13px;
  pointer-events: none;
}

.ev-item {
  background: rgba(0, 0, 0, 0.45);
  border-radius: 4px;
  padding: 3px 8px;
  margin-bottom: 3px;
  text-shadow: 0 1px 2px #000;
}

.ev-name { color: #ffcc66; font-weight: bold; }
.ev-victim { color: #ff6655; }
.ev-sep { color: #aaa; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.4s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── Esquina stats ──────────────────────────────────────── */
.corner-stats {
  position: absolute;
  top: 20px;
  left: 20px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.6;
  pointer-events: none;
}
</style>
