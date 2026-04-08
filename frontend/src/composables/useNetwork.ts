import { ref, shallowRef } from 'vue'
import type {
  ServerMessage,
  WorldSnapshot,
  GameEvent,
  QueueUpdate,
  WelcomeMessage,
  InputFrame,
  HelloMessage,
  SwingDirection,
} from '../types/protocol'

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8082/game'

export type NetworkStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QUEUE'
  | 'IN_GAME'
  | 'ERROR'

export function useNetwork() {
  const status = ref<NetworkStatus>('DISCONNECTED')
  const latestSnapshot = shallowRef<WorldSnapshot | null>(null)
  const gameEvents = ref<GameEvent[]>([])
  const queueInfo = ref<QueueUpdate | null>(null)
  const welcomeInfo = ref<WelcomeMessage | null>(null)
  const localPlayerId = ref<string>('')
  const pingMs = ref<number>(0)

  let socket: WebSocket | null = null
  let inputSeq = 0
  let pingInterval: ReturnType<typeof setInterval> | null = null
  let lastPingSent = 0

  function connect(playerName: string) {
    if (socket) socket.close()
    status.value = 'CONNECTING'

    socket = new WebSocket(WS_URL)

    socket.onopen = () => {
      const hello: HelloMessage = { type: 'HELLO', playerName }
      socket!.send(JSON.stringify(hello))
    }

    socket.onmessage = (ev) => {
      const msg: ServerMessage = JSON.parse(ev.data as string)
      handleMessage(msg)
    }

    socket.onerror = () => {
      status.value = 'ERROR'
    }

    socket.onclose = () => {
      status.value = 'DISCONNECTED'
      if (pingInterval) clearInterval(pingInterval)
    }
  }

  function handleMessage(msg: ServerMessage) {
    if (msg.type === 'WELCOME') {
      welcomeInfo.value = msg as WelcomeMessage
      localPlayerId.value = (msg as WelcomeMessage).playerId
      status.value = 'IN_GAME'
      startPing()
    } else if (msg.type === 'QUEUE_UPDATE') {
      queueInfo.value = msg as QueueUpdate
      status.value = 'QUEUE'
    } else if (msg.type === 'SNAPSHOT') {
      latestSnapshot.value = msg as WorldSnapshot
    } else {
      // GameEvent
      gameEvents.value.push(msg as GameEvent)
      if (gameEvents.value.length > 20) gameEvents.value.shift()
    }
  }

  function sendInput(
    seq: number,
    move: { x: number; z: number },
    yaw: number,
    pitch: number,
    attackStart: boolean,
    attackRelease: boolean,
    blockDown: boolean,
    blockUp: boolean,
    swingDir: SwingDirection,
    jump: boolean,
  ) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const frame: InputFrame = {
      type: 'INPUT',
      seq,
      timestamp: performance.now(),
      move,
      yaw,
      pitch,
      attackStart,
      attackRelease,
      blockDown,
      blockUp,
      swingDir,
      jump,
    }
    socket.send(JSON.stringify(frame))
  }

  function nextSeq() {
    return ++inputSeq
  }

  function startPing() {
    pingInterval = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        lastPingSent = performance.now()
        socket.send(JSON.stringify({ type: 'PING', t: lastPingSent }))
      }
    }, 2000)
  }

  function disconnect() {
    socket?.close()
  }

  return {
    status,
    latestSnapshot,
    gameEvents,
    queueInfo,
    welcomeInfo,
    localPlayerId,
    pingMs,
    connect,
    disconnect,
    sendInput,
    nextSeq,
  }
}
