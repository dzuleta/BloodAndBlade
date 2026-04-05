import { ref, onUnmounted } from 'vue'
import type { SwingDirection } from '../types/protocol'

export function useInput(canvas: HTMLElement) {
  const locked = ref(false)

  // Movimiento acumulado
  const keys = { w: false, a: false, s: false, d: false, space: false }

  // Rotación acumulada desde el último envío
  let yawAcc = 0
  let pitchAcc = 0
  const yaw = ref(0)
  const pitch = ref(0)

  // Combate
  const attackStart = ref(false)
  const attackRelease = ref(false)
  const blockDown = ref(false)
  const blockUp = ref(false)
  const swingDir = ref<SwingDirection>('RIGHT')

  // Mouse delta acumulado en este frame (para cámara)
  let mouseDX = 0
  let mouseDY = 0

  // Acumulador de movimiento relativo desde que se apretó el botón (para dirección de combate)
  let swingAccX = 0
  let swingAccY = 0
  let isLeftHeld = false
  let isRightHeld = false

  // Píxeles acumulados mínimos para confirmar una dirección
  const SWING_THRESHOLD = 35

  const SENSITIVITY = 0.002
  const PITCH_LIMIT = Math.PI / 2.2

  function calcSwingDir(ax: number, ay: number): SwingDirection {
    if (Math.abs(ax) > Math.abs(ay)) {
      return ax > 0 ? 'RIGHT' : 'LEFT'
    } else {
      return ay > 0 ? 'DOWN' : 'UP'
    }
  }

  function onMouseMove(e: MouseEvent) {
    if (!locked.value) return
    mouseDX += e.movementX
    mouseDY += e.movementY

    // Acumular movimiento relativo mientras se tenga un botón apretado
    if (isLeftHeld || isRightHeld) {
      swingAccX += e.movementX
      swingAccY += e.movementY
      const dist = Math.sqrt(swingAccX * swingAccX + swingAccY * swingAccY)
      if (dist >= SWING_THRESHOLD) {
        swingDir.value = calcSwingDir(swingAccX, swingAccY)
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW': keys.w = true; break
      case 'KeyA': keys.a = true; break
      case 'KeyS': keys.s = true; break
      case 'KeyD': keys.d = true; break
      case 'Space': keys.space = true; break
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW': keys.w = false; break
      case 'KeyA': keys.a = false; break
      case 'KeyS': keys.s = false; break
      case 'KeyD': keys.d = false; break
      case 'Space': keys.space = false; break
    }
  }

  function onMouseDown(e: MouseEvent) {
    if (!locked.value) return
    // Resetear el acumulador de dirección en cada nuevo press
    swingAccX = 0
    swingAccY = 0
    if (e.button === 0) {
      attackStart.value = true
      isLeftHeld = true
    }
    if (e.button === 2) {
      blockDown.value = true
      isRightHeld = true
    }
  }

  function onMouseUp(e: MouseEvent) {
    if (e.button === 0) {
      attackRelease.value = true
      isLeftHeld = false
    }
    if (e.button === 2) {
      blockUp.value = true
      isRightHeld = false
    }
  }

  function onContextMenu(e: Event) {
    e.preventDefault()
  }

  function onLockChange() {
    locked.value = document.pointerLockElement === canvas
  }

  function requestLock() {
    canvas.requestPointerLock()
  }

  // Aplica el delta del mouse a yaw/pitch y devuelve movimiento+cámara.
  // Llamar en cada frame visual. NO resetea flags de combate.
  function sampleMovement() {
    yawAcc += mouseDX * SENSITIVITY
    pitchAcc += mouseDY * SENSITIVITY
    mouseDX = 0
    mouseDY = 0

    yaw.value = yawAcc
    pitch.value = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchAcc))

    let mx = 0
    let mz = 0
    if (keys.w) mz -= 1
    if (keys.s) mz += 1
    if (keys.a) mx -= 1
    if (keys.d) mx += 1

    const len = Math.sqrt(mx * mx + mz * mz)
    if (len > 0) { mx /= len; mz /= len }

    return { move: { x: mx, z: mz }, yaw: yaw.value, pitch: pitch.value }
  }

  // Construye el frame completo para enviar a la red y resetea los pulsos de combate.
  // Llamar solo en el intervalo de red (30 Hz). NO aplica mouse delta (ya lo hace sampleMovement).
  function consumeFrame() {
    let mx = 0
    let mz = 0
    if (keys.w) mz -= 1
    if (keys.s) mz += 1
    if (keys.a) mx -= 1
    if (keys.d) mx += 1

    const len = Math.sqrt(mx * mx + mz * mz)
    if (len > 0) { mx /= len; mz /= len }

    const frame = {
      move: { x: mx, z: mz },
      yaw: yaw.value,
      pitch: pitch.value,
      attackStart: attackStart.value,
      attackRelease: attackRelease.value,
      blockDown: blockDown.value,
      blockUp: blockUp.value,
      swingDir: swingDir.value,
      jump: keys.space,
    }

    attackStart.value = false
    attackRelease.value = false
    blockDown.value = false
    blockUp.value = false

    return frame
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('pointerlockchange', onLockChange)
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('click', requestLock)

  onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('pointerlockchange', onLockChange)
    canvas.removeEventListener('contextmenu', onContextMenu)
    canvas.removeEventListener('click', requestLock)
    if (document.pointerLockElement) document.exitPointerLock()
  })

  function getCombatState() {
    return {
      isLeftHeld,
      isRightHeld,
      swingDir: swingDir.value,
      swingMagnitude: Math.sqrt(swingAccX * swingAccX + swingAccY * swingAccY),
    }
  }

  return { locked, yaw, pitch, requestLock, sampleMovement, consumeFrame, getCombatState }
}
