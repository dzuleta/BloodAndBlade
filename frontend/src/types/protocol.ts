// ─── Mensajes: Cliente → Servidor ───────────────────────────────────────────

export type SwingDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'

export interface InputFrame {
  type: 'INPUT'
  seq: number
  timestamp: number
  move: { x: number; z: number }  // WASD normalizado
  yaw: number                      // rotación horizontal (radianes)
  pitch: number                    // rotación vertical (radianes)
  attackStart: boolean
  attackRelease: boolean
  blockDown: boolean
  blockUp: boolean
  swingDir: SwingDirection
  jump: boolean
}

export interface HelloMessage {
  type: 'HELLO'
  playerName: string
}

// ─── Mensajes: Servidor → Cliente ───────────────────────────────────────────

export interface RemotePlayer {
  id: string
  name: string
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  health: number
  maxHealth: number
  swingPhase: 'IDLE' | 'WINDUP' | 'RELEASE' | 'RECOVERY' | 'BLOCKED'
  swingDir: SwingDirection
  blocking: boolean
  blockDir: SwingDirection
  momentum: number
  kills: number
  deaths: number
  team: string
}

export interface WorldSnapshot {
  type: 'SNAPSHOT'
  tick: number
  serverTime: number
  players: RemotePlayer[]
  localPlayerId: string
  roundTimeLeft: number
  worldObjects: any[]
}

export type GameEventType =
  | 'PLAYER_HIT'
  | 'PLAYER_KILLED'
  | 'BLOCK_SUCCESS'
  | 'FEINT'
  | 'PLAYER_JOINED'
  | 'PLAYER_LEFT'

export interface GameEvent {
  type: GameEventType
  attackerId?: string
  victimId?: string
  damage?: number
  zone?: 'HEAD' | 'TORSO' | 'LEGS'
  message?: string
}

export interface QueueUpdate {
  type: 'QUEUE_UPDATE'
  position: number
  total: number
}

export interface WelcomeMessage {
  type: 'WELCOME'
  playerId: string
  worldWidth: number
  worldDepth: number
  team: string
}

export type ServerMessage =
  | WorldSnapshot
  | GameEvent
  | QueueUpdate
  | WelcomeMessage
