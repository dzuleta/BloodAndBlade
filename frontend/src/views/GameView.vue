<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import HUD from '../components/HUD.vue'
import { useNetwork } from '../composables/useNetwork'
import { useGame } from '../composables/useGame'
import { useInput } from '../composables/useInput'
import type { RemotePlayer } from '../types/protocol'

const router = useRouter()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const showQueue = ref(false)

const network = useNetwork()
const game = shallowRef<ReturnType<typeof useGame> | null>(null)
const input = shallowRef<ReturnType<typeof useInput> | null>(null)

// ─── Input loop a 30 Hz ───────────────────────────────────────────────────
let inputIntervalId: ReturnType<typeof setInterval> | null = null
const INPUT_RATE_MS = 33

const localPlayer = computed<RemotePlayer | null>(() => {
  const snap = network.latestSnapshot.value
  if (!snap || !network.localPlayerId.value) return null
  return snap.players.find(p => p.id === network.localPlayerId.value) ?? null
})

const allPlayers = computed<RemotePlayer[]>(() => {
  return network.latestSnapshot.value?.players ?? []
})

const camToggleLabel = computed(() => {
  const g = game.value
  if (!g?.thirdPerson) return 'Toggle View (H)'
  return g.thirdPerson.value ? 'Toggle View (H)' : 'Toggle View (H)'
})

function onTogglePerspective() {
  game.value?.toggleThirdPersonView()
}

function onCamToggleKeydown(e: KeyboardEvent) {
  if (e.code !== 'KeyH' || e.repeat) return
  if (network.status.value !== 'IN_GAME') return
  onTogglePerspective()
}

onMounted(() => {
  document.addEventListener('keydown', onCamToggleKeydown)
  const canvas = canvasRef.value!
  const playerName = sessionStorage.getItem('playerName') ?? 'Anonymous'

  const g = useGame(canvas)
  game.value = g
  input.value = useInput(canvas)

  g.localId.value = ''

  // Conectar al backend
  network.connect(playerName)

  // Cuando llega WELCOME, actualizar el localId en game
  const stopWatch = setInterval(() => {
    const pid = network.localPlayerId.value
    const wInfo = network.welcomeInfo.value
    if (pid && game.value) {
      if (wInfo) {
        game.value.onWelcome(pid, wInfo.worldWidth, wInfo.worldDepth, wInfo.team)
      } else {
        game.value.localId.value = pid
      }
      game.value.refreshCharacterMeshes()
      clearInterval(stopWatch)
    }
  }, 100)

  // Enviar inputs a 30 Hz
  inputIntervalId = setInterval(() => {
    if (!input.value || network.status.value !== 'IN_GAME') return
    const frame = input.value.consumeFrame()
    network.sendInput(
      network.nextSeq(),
      frame.move,
      frame.yaw,
      frame.pitch,
      frame.attackStart,
      frame.attackRelease,
      frame.attackHeld,
      frame.blockDown,
      frame.blockUp,
      frame.swingDir,
      frame.jump,
    )
  }, INPUT_RATE_MS)

  // Mostrar queue
  const stopQueue = setInterval(() => {
    showQueue.value = network.status.value === 'QUEUE'
    if (network.status.value === 'IN_GAME') clearInterval(stopQueue)
  }, 300)

  watch(
    () => network.gameEvents.value.length,
    () => {
      const evs = network.gameEvents.value
      if (evs.length === 0 || !game.value) return
      const ev = evs[evs.length - 1]
      
      const snap = network.latestSnapshot.value
      
      if (ev.type === 'PLAYER_HIT') {
        const victim = snap?.players.find((p) => p.id === ev.victimId)
        if (victim) game.value.applyHitImpact(victim.x, victim.y + 1.2, victim.z)
      } else if (ev.type === 'BLOCK_SUCCESS') {
        const blocker = snap?.players.find((p) => p.id === ev.attackerId) // en el evento, attacker es el que bloqueó
        if (blocker) game.value.applyClashImpact(blocker.x, blocker.y + 1.2, blocker.z)
      }
    },
  )

  // Game loop visual
  g.startLoop((dt: number) => {
    const gv = game.value
    if (!input.value || !gv) return

    // Predicción local (sin esperar snapshot)
    const movement = input.value.sampleMovement()
    gv.applyLocalMovement(movement.move.x, movement.move.z, movement.yaw, movement.pitch, dt)

    // Aplicar correcciones del servidor y actualizar remotes
    const snap = network.latestSnapshot.value
    if (snap) {
      gv.pushSnapshot(snap)
      gv.applyServerCorrection(snap)
    }

    // Animación: mantener LMB = carga (WINDUP, sin daño); soltar = RELEASE hasta que el snapshot avance.
    // La espada en 3ª persona copia la matriz mundial de esta misma espada (mismo movimiento que en 1ª).
    const combat = input.value.getCombatState()
    if (combat.isLeftHeld || combat.isRightHeld) {
      gv.setSwordFromInput(combat.isLeftHeld, combat.isRightHeld, combat.swingDir, combat.swingMagnitude)
    } else if (snap) {
      const me = snap.players.find(p => p.id === network.localPlayerId.value)
      if (me) {
        const bridgeRelease =
          me.swingPhase === 'WINDUP' && !combat.isLeftHeld
        const phase = bridgeRelease ? 'RELEASE' : me.swingPhase
        gv.setSwordAnimation(phase, me.swingDir, me.blocking, me.blockDir)
      }
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', onCamToggleKeydown)
  if (inputIntervalId) clearInterval(inputIntervalId)
  network.disconnect()
})

function backToLobby() {
  network.disconnect()
  router.push('/')
}
</script>

<template>
  <div class="game-container">
    <canvas ref="canvasRef" class="game-canvas" />

    <!-- HUD (solo cuando estamos en partida) -->
    <HUD
      v-if="network.status.value === 'IN_GAME'"
      :local-player="localPlayer"
      :players="allPlayers"
      :events="network.gameEvents.value"
      :fps="game?.fps.value ?? 0"
      :ping="network.pingMs.value"
      :round-time-left="game?.roundTimeLeft.value ?? 0"
      :current-team="game?.localPlayerTeam.value ?? ''"
      :intended-swing-dir="input?.swingDir.value"
      :is-charging="input?.isLeftHeld.value || input?.isRightHeld.value"
      :is-attack-charging="input?.isLeftHeld.value"
    />

    <!-- Overlay de cola de espera -->
    <Transition name="fade">
      <div v-if="showQueue && network.queueInfo.value" class="queue-overlay">
        <div class="queue-card">
          <div class="queue-title">WAITING IN QUEUE</div>
          <div class="queue-pos">Position {{ network.queueInfo.value.position }}</div>
          <div class="queue-sub">of {{ network.queueInfo.value.total }} in queue</div>
          <div class="queue-note">The world supports 64 warriors at a time.<br>You will be admitted when a slot opens.</div>
        </div>
      </div>
    </Transition>

    <!-- Overlay de conexión -->
    <Transition name="fade">
      <div v-if="network.status.value === 'CONNECTING'" class="connecting-overlay">
        <div class="connecting-text">Connecting to the battlefield…</div>
      </div>
    </Transition>

    <!-- Overlay de error -->
    <Transition name="fade">
      <div v-if="network.status.value === 'ERROR' || network.status.value === 'DISCONNECTED'" class="error-overlay">
        <div class="error-card">
          <div class="error-title">Connection lost</div>
          <button class="btn-back" @click="backToLobby">Back to lobby</button>
        </div>
      </div>
    </Transition>

    <!-- Click para capturar cursor -->
    <Transition name="fade">
      <div v-if="network.status.value === 'IN_GAME' && !(input?.locked)" class="lock-hint" @click="input?.requestLock()">
        Click to play
      </div>
    </Transition>

    <button
      v-if="network.status.value === 'IN_GAME'"
      type="button"
      class="btn-cam-perspective"
      @click="onTogglePerspective"
    >
      {{ camToggleLabel }}
    </button>
  </div>
</template>

<style scoped>
.game-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.game-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Overlays ──────────────────────────────────────── */
.queue-overlay,
.connecting-overlay,
.error-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  z-index: 10;
}

.queue-card, .error-card {
  text-align: center;
  background: rgba(10, 8, 6, 0.9);
  border: 1px solid rgba(180, 120, 40, 0.4);
  border-radius: 12px;
  padding: 40px 50px;
}

.queue-title {
  font-size: 13px;
  letter-spacing: 3px;
  color: #c8a860;
  margin-bottom: 16px;
}

.queue-pos {
  font-size: 48px;
  font-weight: 900;
  color: #ffdd88;
}

.queue-sub {
  font-size: 14px;
  color: #7a6040;
  margin-bottom: 20px;
}

.queue-note {
  font-size: 13px;
  color: #555;
  line-height: 1.6;
}

.connecting-text {
  font-size: 18px;
  letter-spacing: 2px;
  color: #c8a860;
}

.error-title {
  font-size: 22px;
  color: #cc4444;
  margin-bottom: 24px;
}

.btn-back {
  padding: 12px 28px;
  background: #8b1010;
  border: 1px solid #cc2222;
  border-radius: 6px;
  color: #ffeedd;
  font-size: 14px;
  font-weight: bold;
  cursor: pointer;
  letter-spacing: 1px;
}

.btn-back:hover { background: #aa1515; }

.lock-hint {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 24px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 200, 100, 0.3);
  border-radius: 8px;
  font-size: 15px;
  letter-spacing: 1px;
  cursor: pointer;
  z-index: 5;
  pointer-events: all;
}

.btn-cam-perspective {
  position: absolute;
  right: 16px;
  bottom: 20px;
  z-index: 6;
  padding: 10px 14px;
  background: rgba(15, 22, 32, 0.85);
  border: 1px solid rgba(120, 170, 210, 0.45);
  border-radius: 8px;
  color: #d0e4f5;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  pointer-events: all;
}

.btn-cam-perspective:hover {
  background: rgba(25, 40, 58, 0.92);
  border-color: rgba(160, 200, 240, 0.6);
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
