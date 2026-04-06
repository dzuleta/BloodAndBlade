import { ref, shallowRef, onUnmounted } from 'vue'
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { Sky } from 'three/addons/objects/Sky.js'
import type { WorldSnapshot, RemotePlayer } from '../types/protocol'

const PLAYER_HEIGHT = 1.8
const INTERP_DELAY_MS = 120
let WORLD_SIZE_W = 80
let WORLD_SIZE_D = 160

/** KayKit Adventurers (FBX + texturas en /public/models/kaykit) */
const KAYKIT_BASE = '/models/kaykit/'
/** El FBX mira al revés respecto al yaw del juego (−tyaw en el padre) */
const KAYKIT_BODY_YAW_OFFSET = Math.PI
/**
 * Orientación del mesh `sword_2handed`: hoja ~+Y local del grupo animado (empuñadura abajo).
 * Y=π corrige el frente de la hoja; Z negativo invierte respecto al primer intento que quedaba horizontal/al revés.
 */
const KAYKIT_SWORD_BLADE_ALIGN = new THREE.Euler(0, 0, 0)

type KayKitTemplates = {
  barbarian: THREE.Object3D
  knight: THREE.Object3D
  swordBarbarian: THREE.Object3D
  swordKnight: THREE.Object3D
}

type SharedClips = {
  idle: THREE.AnimationClip | null
  walk: THREE.AnimationClip | null
  run: THREE.AnimationClip | null
}

/** Grados → radianes (siempre usando Math.PI) */
const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * Posición de la espada en espacio local (1ª persona: hijo de swordYawPivot en ojos; remoto: hijo del mesh del cuerpo).
 * three.Vector3(xRight, yUp, zDepth) coincide con tu notación (X, Z, Y) si identificas:
 *   X → .x (+ derecha)
 *   Z (arriba) → .y (+ arriba)
 *   Y (profundidad) → .z (+ atrás hacia ti, − adelante hacia el oponente)
 */
function fpSwordPos(xRight: number, zUpAsY: number, yDepthAsZ: number) {
  return new THREE.Vector3(xRight, zUpAsY, yDepthAsZ)
}

/** Guardia en 1ª persona: posición/rotación absolutas de reposo (tras RECOVERY/IDLE). No mutar; usar .clone() al asignar targets. */
const SWING_REST = {
  pos: fpSwordPos(0.5, -0.7, -0.8),
  rot: new THREE.Euler(0, 0, 0),
}

interface SnapshotEntry {
  serverTime: number
  receivedAt: number
  players: Map<string, RemotePlayer>
}

export function useGame(canvas: HTMLCanvasElement) {
  const fps = ref(0)
  const localId = ref('')
  const localPlayerTeam = ref('')
  const roundTimeLeft = ref(0)
  const destructibleMeshes = new Map<string, THREE.Mesh>()

  // ─── Three.js core ────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a0c14)
  scene.fog = new THREE.FogExp2(0x0a0c14, 0.012)

  const sky = new Sky()
  sky.scale.setScalar(450000)
  scene.add(sky)

  const sunPosition = new THREE.Vector3()
  function updateSky() {
    const uniforms = sky.material.uniforms;
    uniforms['turbidity'].value = 10;
    uniforms['rayleigh'].value = 3;
    uniforms['mieCoefficient'].value = 0.005;
    uniforms['mieDirectionalG'].value = 0.7;

    const phi = THREE.MathUtils.degToRad(90 - 4); // Altura del sol (atardecer)
    const theta = THREE.MathUtils.degToRad(180);
    sunPosition.setFromSphericalCoords(1, phi, theta);
    uniforms['sunPosition'].value.copy(sunPosition);
  }
  updateSky()

  const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 200)
  const cameraThird = new THREE.PerspectiveCamera(62, canvas.clientWidth / canvas.clientHeight, 0.1, 200)
  const thirdPerson = ref(false)
  const tpCamBack = 3.55
  const tpCamRaise = 1.22
  const fwScratch = new THREE.Vector3()
  const _mInvAvatar = new THREE.Matrix4()
  const _mSwordLocal = new THREE.Matrix4()

  // ─── Iluminación ─────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0xfff3e0, 0.65)
  scene.add(ambient)

  const sun = new THREE.DirectionalLight(0xffddaa, 2.5)
  sun.position.set(40, 50, 20)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 0.5
  sun.shadow.camera.far = 250
  sun.shadow.camera.left = -60
  sun.shadow.camera.right = 60
  sun.shadow.camera.top = 60
  sun.shadow.camera.bottom = -60
  sun.shadow.normalBias = 0.08
  sun.shadow.bias = -0.0005
  scene.add(sun)

  const skyFill = new THREE.HemisphereLight(0x6688cc, 0x443300, 1.2)
  scene.add(skyFill)

  // ─── Terreno ──────────────────────────────────────────────────────────────
  const texLoader = new THREE.TextureLoader()
  const groundTex = texLoader.load('/textures/ground.png')
  groundTex.wrapS = THREE.RepeatWrapping
  groundTex.wrapT = THREE.RepeatWrapping
  groundTex.repeat.set(24, 24)
  groundTex.colorSpace = THREE.SRGBColorSpace

  const groundGeo = new THREE.PlaneGeometry(WORLD_SIZE_W * 2, WORLD_SIZE_D * 2)
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 1,
    metalness: 0,
    color: 0x555555
  })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  // Bordes de nivel y árboles
  buildArena()

  // ─── Espada en primera persona (arma del jugador local) ───────────────────
  // Pivote a altura de ojos con solo yaw: la espada no hereda el pitch del ratón; solo anima hacia targets al atacar/bloquear.
  const swordYawPivot = new THREE.Group()
  scene.add(swordYawPivot)
  const swordGroup = new THREE.Group()
  swordGroup.position.copy(SWING_REST.pos)
  swordYawPivot.add(swordGroup)
  scene.add(camera)

  // ─── Mesh pool para jugadores remotos ────────────────────────────────────
  const remoteMeshes = new Map<string, THREE.Group>()
  /** Plantillas FBX KayKit (null hasta que cargue loadKayKitAssets) */
  let kayKitTemplates: KayKitTemplates | null = null
  const sharedClips: SharedClips = { idle: null, walk: null, run: null }
  const mixers = new Map<string, THREE.AnimationMixer>()

  // ─── Estado de interpolación ─────────────────────────────────────────────
  const snapshotBuffer: SnapshotEntry[] = []
  const localSnapshot = shallowRef<WorldSnapshot | null>(null)

  function onWelcome(pid: string, w: number, d: number, teamStr: string) {
    localId.value = pid
    localPlayerTeam.value = teamStr
    WORLD_SIZE_W = w
    WORLD_SIZE_D = d
    
    // Reconstruir terreno
    ground.geometry.dispose()
    ground.geometry = new THREE.PlaneGeometry(w, d)
    ground.material.map!.repeat.set(w / 4, d / 4)
    
    // Reconstruir arena
    scene.children.filter(c => c.userData.isWall).forEach(c => scene.remove(c))
    buildArena()
    refreshCharacterMeshes()
  }

  // Posición local (predicción del cliente)
  let localX = 0
  let localY = PLAYER_HEIGHT / 2
  let localZ = 0
  let localYaw = 0
  let localPitch = 0

  // ─── Animación de espada ─────────────────────────────────────────────────
  let swordTargetPos = SWING_REST.pos.clone()
  let swordTargetRot = SWING_REST.rot.clone()
  /** Durante BLOCKED: sin suavizado, la espada queda fija en la pose de rechazo */
  let swordBlockedRigid = false
  /** Ventana en que el RELEASE interpola más fuerte (lectura del swing al soltar) */
  let swordStrikeBoostUntil = 0

  // 1ª persona: swordGroup hijo de swordYawPivot (ojos, solo yaw); origen local (0,0,0) ≈ frente al pecho; hoja en +Y del grupo. No pitch del ratón.
  // fpSwordPos(xRight, zUp, yDepth) → THREE.Vector3; Euler en rad vía rad() o Math.PI.
  //
  // UP — click: sube en la misma columna; release: tajo ~90° al frente.
  // LEFT / RIGHT — flanco; release: arco al frente. DOWN — baja; release: sube al frente.
  //Desplazamiento de la espada:
  // x, z, y: xRight, zUpAsY, yDepthAsZ : (0, 0, 0) es el centro de la cámara. Hoja del mesh en +Y local del grupo.
  // x: +es hacia la derecha, - es hacia la izquierda
  // z: +es hacia arriba, - es hacia abajo
  // y: -es hacia el frente, + es hacia atrás
  // Rotacion de la espada:
  // x, z, y: xRight, zUpAsY, yDepthAsZ : (0, 0, 0) es el pivote (ojos, sin pitch). Hoja del mesh en +Y local del grupo.
  // x: +es hacia la derecha, - es hacia la izquierda
  // z: +es hacia arriba, - es hacia abajo
  // y: -es hacia la derecha, + es hacia la izquierda
  const SWING_WINDUP_DIRS = {
    UP: {
      pos: fpSwordPos(0.48, 0.58, -0.76),
      rot: new THREE.Euler(rad(20), 0, 0),
    },
    DOWN: {
      pos: fpSwordPos(0.48, -0.3, +0.3),
      rot: new THREE.Euler(rad(-90), 0, 0),
    },
    RIGHT: {
      pos: fpSwordPos(0.5, +0.15, -0.30),
      rot: new THREE.Euler(0, 0, rad(-70)),
    },
    LEFT: {
      pos: fpSwordPos(-0.5, +0.15, -0.30),
      rot: new THREE.Euler(0, 0, rad(70)),
    },
  }
  const SWING_RELEASE_DIRS = {
    UP: {
      pos: fpSwordPos(0.46, -0.22, -0.32),
      rot: new THREE.Euler(rad(-110), 0, 0),
    },
    DOWN: {
      pos: fpSwordPos(0.48, -0.3, -0.7),
      rot: new THREE.Euler(rad(-90), 0, 0),
    },
    RIGHT: {
      pos: fpSwordPos(-0.34, 0, -0.32),
      rot: new THREE.Euler(-rad(90), rad(22), rad(115)),
    },
    LEFT: {
      pos: fpSwordPos(0.34, 0, -0.32),
      rot: new THREE.Euler(-rad(90), rad(22), rad(-115)),
    },
  }
  const BLOCK_DIRS = {
    RIGHT: { pos: fpSwordPos(0.8, -0.3, -0.62), rot: new THREE.Euler(0, 0, 0) },
    LEFT: { pos: fpSwordPos(-0.8, -0.3, -0.62), rot: new THREE.Euler(0, 0, 0) },
    UP: {
      pos: fpSwordPos(0.5, 0.62, -0.52),
      rot: new THREE.Euler(0, 0, rad(90)),
    },
    DOWN: {
      pos: fpSwordPos(0.5, -0.6, -0.1),
      rot: new THREE.Euler(rad(-45), 0, rad(45)),
    },
  }

  /**
   * Remotos: misma rotación que 1ª persona; posición = FP + offset (ojos → raíz del cuerpo / espada KayKit).
   * Solo ajusta este vector hasta que el gesto coincida en otros jugadores; el servidor no usa estos números.
   */
  const FP_TO_REMOTE_BODY_OFFSET = new THREE.Vector3(0.38, 0.78, 0.42)

  function remoteSwordPoseFromFp(fp: { pos: THREE.Vector3; rot: THREE.Euler }) {
    return {
      pos: fpSwordPos(
        fp.pos.x + FP_TO_REMOTE_BODY_OFFSET.x,
        fp.pos.y + FP_TO_REMOTE_BODY_OFFSET.y,
        fp.pos.z + FP_TO_REMOTE_BODY_OFFSET.z,
      ),
      rot: new THREE.Euler(fp.rot.x, fp.rot.y, fp.rot.z, fp.rot.order),
    }
  }

  const REMOTE_WINDUP_DIRS = {
    UP: remoteSwordPoseFromFp(SWING_WINDUP_DIRS.UP),
    DOWN: remoteSwordPoseFromFp(SWING_WINDUP_DIRS.DOWN),
    RIGHT: remoteSwordPoseFromFp(SWING_WINDUP_DIRS.RIGHT),
    LEFT: remoteSwordPoseFromFp(SWING_WINDUP_DIRS.LEFT),
  }
  const REMOTE_RELEASE_DIRS = {
    UP: remoteSwordPoseFromFp(SWING_RELEASE_DIRS.UP),
    DOWN: remoteSwordPoseFromFp(SWING_RELEASE_DIRS.DOWN),
    RIGHT: remoteSwordPoseFromFp(SWING_RELEASE_DIRS.RIGHT),
    LEFT: remoteSwordPoseFromFp(SWING_RELEASE_DIRS.LEFT),
  }
  const REMOTE_BLOCK_DIRS = {
    RIGHT: remoteSwordPoseFromFp(BLOCK_DIRS.RIGHT),
    LEFT: remoteSwordPoseFromFp(BLOCK_DIRS.LEFT),
    UP: remoteSwordPoseFromFp(BLOCK_DIRS.UP),
    DOWN: remoteSwordPoseFromFp(BLOCK_DIRS.DOWN),
  }
  const REMOTE_REST = remoteSwordPoseFromFp(SWING_REST)

  // ─── Loop ────────────────────────────────────────────────────────────────
  let animId = 0
  let lastTime = 0
  let frameCount = 0
  let fpsTime = 0

  function buildSword(): THREE.Group {
    const group = new THREE.Group()

    // Hoja (+50% largo respecto a 0.88u → 1.32u)
    const bladeGeo = new THREE.BoxGeometry(0.06, 1.32, 0.06)
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1.0,
      roughness: 0.15,
      envMapIntensity: 1.0
    })
    const blade = new THREE.Mesh(bladeGeo, bladeMat)
    blade.position.y = 0.66
    blade.castShadow = true
    group.add(blade)

    // Guardamano
    const guardGeo = new THREE.BoxGeometry(0.30, 0.05, 0.055)
    const guardMat = new THREE.MeshStandardMaterial({
      color: 0xffcc33,
      metalness: 1.0,
      roughness: 0.2
    })
    const guard = new THREE.Mesh(guardGeo, guardMat)
    guard.position.y = -0.02
    group.add(guard)

    // Empuñadura
    const gripGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.26, 8)
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x221100, roughness: 0.8 })
    const grip = new THREE.Mesh(gripGeo, gripMat)
    grip.position.y = -0.19
    group.add(grip)

    return group
  }

  function playerVariant(playerId: string): 'barbarian' | 'knight' {
    if (playerId === '__preview__') return (localPlayerTeam.value === 'BARBARIAN' ? 'barbarian' : 'knight')
    if (localId.value.length > 0 && playerId === localId.value) return (localPlayerTeam.value === 'BARBARIAN' ? 'barbarian' : 'knight')
    
    // Si es un remoto, intentar obtener su equipo del último snapshot
    const snap = localSnapshot.value
    if (snap) {
      const p = snap.players.find(rp => rp.id === playerId)
      if (p && p.team) return (p.team === 'BARBARIAN' ? 'barbarian' : 'knight')
    }
    return 'barbarian'
  }

  function applyPaletteTexture(root: THREE.Object3D, map: THREE.Texture) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (mat && 'map' in mat) {
          ; (mat as THREE.MeshStandardMaterial).map = map
          mat.needsUpdate = true
        }
      }
    })
  }

  function enableShadows(root: THREE.Object3D) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
  }

  /** Escala uniforme para altura ≈ targetH y apoyar pies en y=0 */
  function normalizeCharacterHeight(root: THREE.Object3D, targetH: number) {
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    if (size.y < 1e-4) return
    const s = targetH / size.y
    root.scale.multiplyScalar(s)
    root.updateMatrixWorld(true)
    const b2 = new THREE.Box3().setFromObject(root)
    root.position.y -= b2.min.y
  }

  /** Escala la espada para que su mayor dimensión ≈ targetLen; base del bbox en y=0 */
  function normalizeSwordModel(root: THREE.Object3D, targetLen: number) {
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const L = Math.max(size.x, size.y, size.z)
    if (L < 1e-4) return
    root.scale.multiplyScalar(targetLen / L)
    root.updateMatrixWorld(true)
    const b2 = new THREE.Box3().setFromObject(root)
    root.position.y -= b2.min.y
    root.rotation.copy(KAYKIT_SWORD_BLADE_ALIGN)
    root.updateMatrixWorld(true)
    const b3 = new THREE.Box3().setFromObject(root)
    root.position.y -= b3.min.y
  }

  function fillProceduralBody(body: THREE.Group, tint: number) {
    const bodyMat = new THREE.MeshLambertMaterial({ color: tint })
    const torsoGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.0, 8)
    const torso = new THREE.Mesh(torsoGeo, bodyMat)
    torso.position.y = 0.9
    torso.castShadow = true
    body.add(torso)
    const headGeo = new THREE.SphereGeometry(0.25, 8, 8)
    const head = new THREE.Mesh(headGeo, bodyMat)
    head.position.y = 1.65
    head.castShadow = true
    body.add(head)
  }

  function applyCharacterBody(body: THREE.Group, playerId: string, proceduralTint: number) {
    body.clear()
    if (!kayKitTemplates) {
      fillProceduralBody(body, proceduralTint)
      return
    }
    const v = playerVariant(playerId)
    const tpl = v === 'knight' ? kayKitTemplates.knight : kayKitTemplates.barbarian
    const c = cloneSkinned(tpl)
    c.rotateY(KAYKIT_BODY_YAW_OFFSET)
    body.add(c)

    // Configurar Animación
    if (sharedClips.idle) {
      const mixer = new THREE.AnimationMixer(c)
      const action = mixer.clipAction(sharedClips.idle)
      action.play()
      mixers.set(playerId === '__preview__' ? localIdForModels() : playerId, mixer)
    }
  }

  /**
   * Espada visible: siempre la procedural (cajas) para que coincida con SWING_* y se sienta como antes.
   * El FBX KayKit queda desactivado aquí (más chico / otro pivote); los personajes siguen siendo KayKit si hay assets.
   */
  function mountKayKitSword(into: THREE.Group, _playerId: string) {
    into.clear()
    into.add(buildSword())
  }

  function localIdForModels(): string {
    return localId.value.length > 0 ? localId.value : '__preview__'
  }

  // Primer montaje de la espada (procedural hasta que cargue KayKit)
  mountKayKitSword(swordGroup, '__preview__')

  function buildLocalPlayerAvatar(): THREE.Group {
    const group = new THREE.Group()

    const characterBody = new THREE.Group()
    characterBody.name = 'characterBody'
    group.add(characterBody)
    applyCharacterBody(characterBody, localIdForModels(), 0x3a6b8e)

    const swordAv = new THREE.Group()
    swordAv.name = 'sword'
    mountKayKitSword(swordAv, localIdForModels())
    group.add(swordAv)

    return group
  }

  const localPlayerAvatar = buildLocalPlayerAvatar()
  localPlayerAvatar.visible = false
  scene.add(localPlayerAvatar)

  async function loadKayKitAssets(): Promise<void> {
    const texLoader = new THREE.TextureLoader()
    const fbx = new FBXLoader()
    const url = (f: string) => `${KAYKIT_BASE}${f}`
    const [barTex, knightTex, barFbx, knightFbx, swordRaw] = await Promise.all([
      texLoader.loadAsync(url('barbarian_texture.png')),
      texLoader.loadAsync(url('knight_texture.png')),
      fbx.loadAsync(url('Barbarian.fbx')),
      fbx.loadAsync(url('Knight.fbx')),
      fbx.loadAsync(url('sword_2handed.fbx')),
    ])
    for (const t of [barTex, knightTex]) {
      t.colorSpace = THREE.SRGBColorSpace
      t.magFilter = THREE.NearestFilter
      t.minFilter = THREE.NearestFilter
    }
    applyPaletteTexture(barFbx, barTex)
    applyPaletteTexture(knightFbx, knightTex)
    enableShadows(barFbx)
    enableShadows(knightFbx)
    normalizeCharacterHeight(barFbx, PLAYER_HEIGHT)
    normalizeCharacterHeight(knightFbx, PLAYER_HEIGHT)

    const swordBar = cloneSkinned(swordRaw)
    const swordKnight = cloneSkinned(swordRaw)
    applyPaletteTexture(swordBar, barTex)
    applyPaletteTexture(swordKnight, knightTex)
    enableShadows(swordBar)
    enableShadows(swordKnight)
    normalizeSwordModel(swordBar, 1.28)
    normalizeSwordModel(swordKnight, 1.28)

    kayKitTemplates = {
      barbarian: barFbx,
      knight: knightFbx,
      swordBarbarian: swordBar,
      swordKnight: swordKnight
    };

    // --- CARGAR ANIMACIONES ---
    const [genRig, movRig] = await Promise.all([
      fbx.loadAsync(url('Rig_Medium_General.fbx')),
      fbx.loadAsync(url('Rig_Medium_MovementBasic.fbx')),
    ])

    const findClip = (fbx: THREE.Group, namePart: string) =>
      fbx.animations.find(a => a.name.toLowerCase().includes(namePart.toLowerCase()))

    sharedClips.idle = findClip(genRig, 'Idle') || genRig.animations[0]
    sharedClips.walk = findClip(movRig, 'Walk') || movRig.animations[0]
    sharedClips.run = findClip(movRig, 'Run') || movRig.animations[0]

    refreshCharacterMeshes()
  }

  function refreshCharacterMeshes() {
    const lid = localIdForModels()
    mountKayKitSword(swordGroup, lid)

    const locBody = localPlayerAvatar.getObjectByName('characterBody') as THREE.Group | undefined
    if (locBody) applyCharacterBody(locBody, lid, 0x3a6b8e)

    const locSword = localPlayerAvatar.getObjectByName('sword') as THREE.Group | undefined
    if (locSword) {
      mountKayKitSword(locSword, lid)
      locSword.position.set(0, 0, 0)
      locSword.scale.setScalar(1)
    }

    remoteMeshes.forEach((mesh, id) => {
      const b = mesh.getObjectByName('characterBody') as THREE.Group | undefined
      const s = mesh.getObjectByName('sword') as THREE.Group | undefined
      if (b) applyCharacterBody(b, id, 0x8b2020)
      if (s) {
        mountKayKitSword(s, id)
        s.position.copy(fpSwordPos(0.4, 0.8, 0.1))
        s.scale.setScalar(0.85)
      }
    })
  }

  // ─── Impacto: sangre (partículas) + sonido ───────────────────────────────
  let hitAudioCtx: AudioContext | null = null
  const hitBursts: { g: THREE.Group; t: number }[] = []

  function playHitImpactSound() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      if (!hitAudioCtx) hitAudioCtx = new AC()
      const ctx = hitAudioCtx
      if (ctx.state === 'suspended') void ctx.resume()
      const t0 = ctx.currentTime
      const nSamples = Math.floor(ctx.sampleRate * 0.1)
      const buf = ctx.createBuffer(1, nSamples, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < nSamples; i++) {
        const env = Math.exp(-i / (nSamples * 0.22))
        data[i] = (Math.random() * 2 - 1) * env * 0.45
      }
      const noise = ctx.createBufferSource()
      noise.buffer = buf
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = 700
      const gn = ctx.createGain()
      gn.gain.value = 0.55
      noise.connect(f)
      f.connect(gn)
      gn.connect(ctx.destination)
      noise.start(t0)
      noise.stop(t0 + 0.1)
      const osc = ctx.createOscillator()
      const g2 = ctx.createGain()
      osc.type = 'square'
      osc.frequency.setValueAtTime(220, t0)
      osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.07)
      g2.gain.setValueAtTime(0.06, t0)
      g2.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.09)
      osc.connect(g2)
      g2.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.1)
    } catch {
      /* sin audio */
    }
  }

  function spawnHitBlood(x: number, y: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, y, z)
    for (let i = 0; i < 16; i++) {
      const geo = new THREE.SphereGeometry(0.028 + Math.random() * 0.04, 6, 6)
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.02, 0.85, 0.35 + Math.random() * 0.15),
        transparent: true,
        opacity: 1,
      })
      const m = new THREE.Mesh(geo, mat)
      m.userData.vx = (Math.random() - 0.5) * 2.5
      m.userData.vy = Math.random() * 2 + 0.4
      m.userData.vz = (Math.random() - 0.5) * 2.5
      group.add(m)
    }
    scene.add(group)
    hitBursts.push({ g: group, t: 0 })
  }

  function updateHitBursts(dt: number) {
    for (let i = hitBursts.length - 1; i >= 0; i--) {
      const b = hitBursts[i]
      b.t += dt
      for (const ch of b.g.children) {
        const m = ch as THREE.Mesh
        m.userData.vy -= 6 * dt
        m.position.x += m.userData.vx * dt
        m.position.y += m.userData.vy * dt
        m.position.z += m.userData.vz * dt
        const mat = m.material as THREE.MeshBasicMaterial
        mat.opacity = Math.max(0, 1 - b.t / 0.55)
      }
      if (b.t > 0.55) {
        scene.remove(b.g)
        b.g.children.forEach((c) => {
          const mesh = c as THREE.Mesh
          mesh.geometry.dispose()
            ; (mesh.material as THREE.Material).dispose()
        })
        hitBursts.splice(i, 1)
      }
    }
  }

  /** Partículas + sonido cuando un hit conecta (la espada sigue el RELEASE del servidor sin congelar en contacto) */
  function applyHitImpact(x: number, y: number, z: number) {
    spawnHitBlood(x, y, z)
    playHitImpactSound()
  }

  function playClashSound() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      if (!hitAudioCtx) hitAudioCtx = new AC()
      const ctx = hitAudioCtx
      if (ctx.state === 'suspended') void ctx.resume()
      const t0 = ctx.currentTime

      // Metallic "ting"
      const osc = ctx.createOscillator()
      const gn = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(1200, t0)
      osc.frequency.exponentialRampToValueAtTime(400, t0 + 0.1)
      gn.gain.setValueAtTime(0.3, t0)
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15)
      osc.connect(gn)
      gn.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.15)

      // Noise burst for impact
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.2))
      const noise = ctx.createBufferSource()
      noise.buffer = buf
      const gn2 = ctx.createGain()
      gn2.gain.value = 0.2
      noise.connect(gn2)
      gn2.connect(ctx.destination)
      noise.start(t0)
    } catch { /* sin audio */ }
  }

  function spawnClashSparks(x: number, y: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, y, z)
    for (let i = 0; i < 12; i++) {
      const geo = new THREE.BoxGeometry(0.02, 0.02, 0.02)
      const mat = new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 1 })
      const m = new THREE.Mesh(geo, mat)
      m.userData.vx = (Math.random() - 0.5) * 4
      m.userData.vy = (Math.random() - 0.5) * 4
      m.userData.vz = (Math.random() - 0.5) * 4
      group.add(m)
    }
    scene.add(group)
    hitBursts.push({ g: group, t: 0 })
  }

  function applyClashImpact(x: number, y: number, z: number) {
    spawnClashSparks(x, y, z)
    playClashSound()
  }

  function buildTree(x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.scale.setScalar(0.7 + Math.random() * 0.4)
    group.rotation.y = Math.random() * Math.PI * 2

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1a, roughness: 1 })
    const trunk = new THREE.Mesh(trunkGeo, trunkMat)
    trunk.position.y = 1.5
    trunk.castShadow = true
    trunk.receiveShadow = true
    group.add(trunk)

    // Foliage texture
    const fTex = texLoader.load('/textures/foliage.png')
    fTex.colorSpace = THREE.SRGBColorSpace
    const fMat = new THREE.MeshStandardMaterial({
      map: fTex,
      color: 0x1a4a1a,
      roughness: 1,
      transparent: true,
      alphaTest: 0.5
    })

    // Random leaf blobs
    for (let i = 0; i < 3; i++) {
      const g = new THREE.IcosahedronGeometry(1.6, 0)
      const m = new THREE.Mesh(g, fMat)
      m.position.y = 3.5 + i * 1.2
      m.position.x = (Math.random() - 0.5) * 0.8
      m.position.z = (Math.random() - 0.5) * 0.8
      m.scale.set(1, 0.8, 1)
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }

    scene.add(group)
  }

  function buildArena() {
    // Arena dinámica basada en WORLD_SIZE_W y WORLD_SIZE_D
    scene.children.filter(c => c.userData.isWall).forEach(c => scene.add(c)) // Clean old walls if any? Actually buildArena is only called once.
    
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2d1b0a, roughness: 1 })
    const hW = WORLD_SIZE_W / 2
    const hD = WORLD_SIZE_D / 2
    
    const wallConfigs = [
      { x: 0, z: -hD, rx: 0, w: WORLD_SIZE_W, h: 8 },
      { x: hW, z: 0, rx: Math.PI / 2, w: WORLD_SIZE_D, h: 8 },
      { x: 0, z: hD, rx: Math.PI, w: WORLD_SIZE_W, h: 8 },
      { x: -hW, z: 0, rx: -Math.PI / 2, w: WORLD_SIZE_D, h: 8 },
    ]
    wallConfigs.forEach(({ x, z, rx, w, h }) => {
      const geo = new THREE.BoxGeometry(w, h, 2)
      const mesh = new THREE.Mesh(geo, wallMat)
      mesh.position.set(x, h / 2 - 0.2, z)
      mesh.rotation.y = rx
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.isWall = true
      scene.add(mesh)
    })

    const treePositions = [
      [12, 12], [-12, 12], [12, -12], [-12, -12],
      [22, 0], [-22, 0], [0, 22], [0, -22],
    ]
    treePositions.forEach(([x, z]) => buildTree(x, z))
  }

  function getOrCreateRemoteMesh(id: string): THREE.Group {
    if (remoteMeshes.has(id)) return remoteMeshes.get(id)!
    const group = new THREE.Group()

    const characterBody = new THREE.Group()
    characterBody.name = 'characterBody'
    group.add(characterBody)
    applyCharacterBody(characterBody, id, 0x8b2020)

    const swordRemote = new THREE.Group()
    swordRemote.name = 'sword'
    swordRemote.position.copy(fpSwordPos(0.4, 0.8, 0.1))
    swordRemote.scale.setScalar(0.85)
    mountKayKitSword(swordRemote, id)
    group.add(swordRemote)

    // Barra de vida flotante
    const barGroup = buildHealthBar()
    barGroup.position.y = 2.1
    barGroup.name = 'healthBar'
    group.add(barGroup)

    scene.add(group)
    remoteMeshes.set(id, group)
    return group
  }

  function buildHealthBar(): THREE.Group {
    const g = new THREE.Group()
    const bgGeo = new THREE.PlaneGeometry(1.0, 0.12)
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x330000, depthTest: false, transparent: true, opacity: 0.7 })
    const bg = new THREE.Mesh(bgGeo, bgMat)
    bg.renderOrder = 999
    g.add(bg)

    const fgGeo = new THREE.PlaneGeometry(1.0, 0.1)
    const fgMat = new THREE.MeshBasicMaterial({ color: 0xcc0000, depthTest: false })
    const fg = new THREE.Mesh(fgGeo, fgMat)
    fg.position.z = 0.001
    fg.name = 'hpFill'
    fg.renderOrder = 1000
    g.add(fg)

    return g
  }

  function updateRemoteHealthBar(group: THREE.Group, hp: number, maxHp: number) {
    const barGroup = group.getObjectByName('healthBar') as THREE.Group | undefined
    if (!barGroup) return
    const fill = barGroup.getObjectByName('hpFill') as THREE.Mesh | undefined
    if (!fill) return
    const ratio = Math.max(0, hp / maxHp)
    fill.scale.x = ratio
    fill.position.x = -(1 - ratio) / 2
      ; (fill.material as THREE.MeshBasicMaterial).color.setHex(ratio > 0.5 ? 0x22bb22 : ratio > 0.25 ? 0xffaa00 : 0xcc0000)
    const camPos = thirdPerson.value ? cameraThird.position : camera.position
    barGroup.lookAt(camPos)
  }

  function animateRemoteSword(
    mesh: THREE.Group,
    phase: string, dir: string,
    blocking: boolean, blockDir: string,
    dt: number,
  ) {
    const sword = mesh.getObjectByName('sword') as THREE.Group | undefined
    if (!sword) return

    let tPos: THREE.Vector3
    let tRotX = 0, tRotY = 0, tRotZ = 0

    if (blocking) {
      const d = REMOTE_BLOCK_DIRS[blockDir as keyof typeof REMOTE_BLOCK_DIRS] ?? REMOTE_BLOCK_DIRS.RIGHT
      tPos = d.pos; tRotX = d.rot.x; tRotY = d.rot.y; tRotZ = d.rot.z
    } else if (phase === 'WINDUP') {
      const d = REMOTE_WINDUP_DIRS[dir as keyof typeof REMOTE_WINDUP_DIRS] ?? REMOTE_WINDUP_DIRS.RIGHT
      tPos = d.pos; tRotX = d.rot.x; tRotY = d.rot.y; tRotZ = d.rot.z
    } else if (phase === 'RELEASE') {
      const d = REMOTE_RELEASE_DIRS[dir as keyof typeof REMOTE_RELEASE_DIRS] ?? REMOTE_RELEASE_DIRS.RIGHT
      tPos = d.pos; tRotX = d.rot.x; tRotY = d.rot.y; tRotZ = d.rot.z
    } else if (phase === 'BLOCKED') {
      tPos = fpSwordPos(0.1, 0.7, 0.2)
      tRotX = rad(6); tRotY = rad(17); tRotZ = 0
    } else {
      tPos = REMOTE_REST.pos; tRotX = 0; tRotY = 0; tRotZ = 0
    }

    // Antes 0.001 (muy rápido), subimos a 0.05 para sentir el peso del arma
    const f = phase === 'BLOCKED' ? 1 : (1 - Math.pow(0.05, dt))
    sword.position.lerp(tPos, f)
    sword.rotation.x += (tRotX - sword.rotation.x) * f
    sword.rotation.y += (tRotY - sword.rotation.y) * f
    sword.rotation.z += (tRotZ - sword.rotation.z) * f
  }

  // ─── Predicción local de movimiento ──────────────────────────────────────
  const MOVE_SPEED = 6.0

  let lastDx = 0, lastDz = 0
  function applyLocalMovement(dx: number, dz: number, yawRad: number, pitchRad: number, dt: number) {
    lastDx = dx; lastDz = dz
    localYaw = yawRad
    localPitch = pitchRad

    if (dx !== 0 || dz !== 0) {
      const sinY = Math.sin(localYaw)
      const cosY = Math.cos(localYaw)
      localX += (cosY * dx - sinY * dz) * MOVE_SPEED * dt
      localZ += (sinY * dx + cosY * dz) * MOVE_SPEED * dt
    }

    // Límites del mundo
    const hW = WORLD_SIZE_W / 2 - 0.5
    const hD = WORLD_SIZE_D / 2 - 0.5
    localX = Math.max(-hW, Math.min(hW, localX))
    localZ = Math.max(-hD, Math.min(hD, localZ))

    camera.position.set(localX, localY + PLAYER_HEIGHT / 2, localZ)
    camera.rotation.order = 'YXZ'
    camera.rotation.y = -localYaw
    camera.rotation.x = -localPitch
  }

  function updateThirdPersonCamera() {
    if (!thirdPerson.value) return
    camera.updateMatrixWorld(true)
    camera.getWorldDirection(fwScratch)
    // fwScratch ahora conserva la inclinación vertical (pitch)
    if (fwScratch.lengthSq() < 1e-6) fwScratch.set(0, 0, 1)
    else fwScratch.normalize()

    const eyeY = localY + PLAYER_HEIGHT / 2
    cameraThird.position
      .set(localX, eyeY, localZ)
      .addScaledVector(fwScratch, -tpCamBack)
    cameraThird.position.y += tpCamRaise
    cameraThird.position.y = Math.max(0.45, cameraThird.position.y)

    // Mirar hacia adelante siguiendo la dirección de la cámara principal
    const target = new THREE.Vector3(localX, eyeY, localZ).addScaledVector(fwScratch, 20)
    cameraThird.lookAt(target)
  }

  function updateLocalPlayerAvatar() {
    // swordYawPivot está en la escena: en 3ª hay que ocultar swordGroup o habría doble espada con el avatar.
    swordGroup.visible = !thirdPerson.value
    localPlayerAvatar.visible = thirdPerson.value && localId.value.length > 0

    const swordAv = localPlayerAvatar.getObjectByName('sword') as THREE.Group | undefined

    if (!thirdPerson.value || !localId.value) {
      if (swordAv && !swordAv.matrixAutoUpdate) {
        swordAv.matrixAutoUpdate = true
        swordAv.position.set(0, 0, 0)
        swordAv.rotation.set(0, 0, 0)
        swordAv.scale.set(1, 1, 1)
      }
      return
    }

    localPlayerAvatar.position.set(localX, localY, localZ)
    localPlayerAvatar.rotation.y = -localYaw

    swordGroup.updateMatrixWorld(true)
    localPlayerAvatar.updateMatrixWorld(true)

    if (swordAv) {
      swordAv.matrixAutoUpdate = false
      _mInvAvatar.copy(localPlayerAvatar.matrixWorld).invert()
      _mSwordLocal.multiplyMatrices(_mInvAvatar, swordGroup.matrixWorld)
      swordAv.matrix.copy(_mSwordLocal)
    }
  }

  function toggleThirdPersonView() {
    thirdPerson.value = !thirdPerson.value
  }

  // ─── Corrección de servidor ───────────────────────────────────────────────
  function applyServerCorrection(snap: WorldSnapshot) {
    const me = snap.players.find(p => p.id === localId.value)
    if (!me) return
    const dx = me.x - localX
    const dz = me.z - localZ
    const dist = Math.sqrt(dx * dx + dz * dz)
    // Corrección suave si la diferencia es pequeña; snap si es grande (teleport / cheat)
    const lerp = dist > 3 ? 1 : 0.15
    localX += dx * lerp
    localZ += dz * lerp
    localY = me.y
  }

  // ─── Interpolación de jugadores remotos ──────────────────────────────────
  function pushSnapshot(snap: WorldSnapshot) {
    if (snap.roundTimeLeft !== undefined) roundTimeLeft.value = snap.roundTimeLeft
    
    // Actualizar objetos destructibles
    if (snap.worldObjects) {
      snap.worldObjects.forEach((obj: any) => {
        let m = destructibleMeshes.get(obj.id)
        if (!m) {
          const isCastle = obj.type === 'CASTLE'
          const geo = new THREE.BoxGeometry(obj.width, isCastle ? 14 : 6, obj.depth)
          const mat = new THREE.MeshStandardMaterial({ 
            color: isCastle ? 0x444444 : 0x332211,
            metalness: 0.1,
            roughness: 0.8
          })
          m = new THREE.Mesh(geo, mat)
          m.position.set(obj.x, (isCastle ? 7 : 3), obj.z)
          m.castShadow = true
          m.receiveShadow = true
          scene.add(m)
          destructibleMeshes.set(obj.id, m)
        }
        
        // Efecto visual según salud
        const hpPct = obj.health / obj.maxHealth
        m.visible = hpPct > 0
        if (m.material instanceof THREE.MeshStandardMaterial) {
          m.material.color.set(obj.type === 'CASTLE' ? 0x444444 : 0x332211).multiplyScalar(0.3 + 0.7 * hpPct)
        }
      })
      
      // Limpiar objetos eliminados del servidor
      destructibleMeshes.forEach((mesh, id) => {
        if (!snap.worldObjects.some(o => o.id === id)) {
          scene.remove(mesh)
          destructibleMeshes.delete(id)
        }
      })
    }

    snapshotBuffer.push({
      serverTime: snap.serverTime,
      receivedAt: performance.now(),
      players: new Map(snap.players.map(p => [p.id, p])),
    })
    if (snapshotBuffer.length > 30) snapshotBuffer.shift()
    localSnapshot.value = snap
  }

  function interpolateRemotes(dt: number) {
    const now = performance.now()
    const renderTime = now - INTERP_DELAY_MS

    // Encontrar par de snapshots que rodean renderTime
    let before: SnapshotEntry | null = null
    let after: SnapshotEntry | null = null

    for (let i = snapshotBuffer.length - 1; i >= 0; i--) {
      const entry = snapshotBuffer[i]
      if (entry.receivedAt <= renderTime) {
        before = entry
        after = snapshotBuffer[i + 1] ?? null
        break
      }
    }

    if (!before) {
      before = snapshotBuffer[0] ?? null
      after = snapshotBuffer[1] ?? null
    }

    if (!before) return

    const ids = new Set<string>()
    before.players.forEach((_, id) => ids.add(id))
    after?.players.forEach((_, id) => ids.add(id))

    ids.forEach(id => {
      if (id === localId.value) return

      const pBefore = before!.players.get(id)
      const pAfter = after?.players.get(id)

      const mesh = getOrCreateRemoteMesh(id)

      let tx: number, ty: number, tz: number, tyaw: number
      let health = 100, maxHealth = 100

      if (pBefore && pAfter) {
        const span = after!.receivedAt - before!.receivedAt
        const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - before!.receivedAt) / span)) : 1
        tx = pBefore.x + (pAfter.x - pBefore.x) * t
        ty = pBefore.y + (pAfter.y - pBefore.y) * t
        tz = pBefore.z + (pAfter.z - pBefore.z) * t
        tyaw = pBefore.yaw + (pAfter.yaw - pBefore.yaw) * t
        health = pAfter.health
        maxHealth = pAfter.maxHealth
      } else {
        const p = pBefore ?? pAfter!
        tx = p.x; ty = p.y; tz = p.z; tyaw = p.yaw
        health = p.health; maxHealth = p.maxHealth
      }

      mesh.position.set(tx, ty, tz)
      mesh.rotation.y = -tyaw
      updateRemoteHealthBar(mesh, health, maxHealth)

      // Animación de espada: usar el snapshot más reciente disponible
      const rp = pAfter ?? pBefore
      if (rp) {
        animateRemoteSword(mesh, rp.swingPhase, rp.swingDir, rp.blocking, rp.blockDir, dt)
      }

      // Animación de cuerpo (Locomoción)
      const mixer = mixers.get(id)
      if (mixer && sharedClips.walk && sharedClips.idle) {
        const velSq = pBefore && pAfter ?
          (Math.pow(pAfter.x - pBefore.x, 2) + Math.pow(pAfter.z - pBefore.z, 2)) : 0
        const isMoving = velSq > 0.0001
        updateMixerState(mixer, isMoving)
      }
    })

    // Limpiar meshes de jugadores desconectados
    remoteMeshes.forEach((mesh, id) => {
      if (!before!.players.has(id)) {
        scene.remove(mesh)
        remoteMeshes.delete(id)
        mixers.delete(id)
      }
    })
  }

  function updateMixerState(mixer: THREE.AnimationMixer, isMoving: boolean) {
    if (!sharedClips.idle || !sharedClips.walk) return
    const idleAction = mixer.clipAction(sharedClips.idle)
    const walkAction = mixer.clipAction(sharedClips.walk)

    if (isMoving) {
      if (idleAction.weight > 0.5) {
        idleAction.crossFadeTo(walkAction, 0.25, true)
        walkAction.play()
      }
    } else {
      if (walkAction.weight > 0.5) {
        walkAction.crossFadeTo(idleAction, 0.25, true)
        idleAction.play()
      }
    }
  }

  // ─── Animación de espada local ────────────────────────────────────────────
  function animateSword(dt: number) {
    const eyeY = localY + PLAYER_HEIGHT / 2
    swordYawPivot.position.set(localX, eyeY, localZ)
    swordYawPivot.rotation.order = 'YXZ'
    swordYawPivot.rotation.y = -localYaw
    swordYawPivot.rotation.x = 0
    swordYawPivot.rotation.z = 0

    const now = performance.now()
    const strikeBoost = now < swordStrikeBoostUntil
    const rigid = swordBlockedRigid
    // t es la fracción de distancia restante por segundo. 
    // Subir de 0.01 -> 0.1 hace que la espada se sienta mucho más pesada y lenta.
    const t = strikeBoost ? 0.06 : 0.12
    const smooth = rigid ? 1 : (1 - Math.pow(t, dt))
    swordGroup.position.lerp(swordTargetPos, smooth)
    swordGroup.rotation.x += (swordTargetRot.x - swordGroup.rotation.x) * smooth
    swordGroup.rotation.y += (swordTargetRot.y - swordGroup.rotation.y) * smooth
    swordGroup.rotation.z += (swordTargetRot.z - swordGroup.rotation.z) * smooth
  }

  // Animación basada en estado del servidor (WINDUP / RELEASE distintos; RECOVERY / BLOCKED)
  function setSwordAnimation(phase: string, dir: string, blocking: boolean, blockDir: string) {
    const now = performance.now()
    swordBlockedRigid = phase === 'BLOCKED'
    swordStrikeBoostUntil = !blocking && phase === 'RELEASE' ? now + 0.50 : 0

    const key = dir as keyof typeof SWING_RELEASE_DIRS

    if (blocking) {
      const d = BLOCK_DIRS[blockDir as keyof typeof BLOCK_DIRS] ?? BLOCK_DIRS.RIGHT
      swordTargetPos = d.pos.clone()
      swordTargetRot = d.rot.clone()
    } else if (phase === 'WINDUP') {
      const d = SWING_WINDUP_DIRS[key] ?? SWING_WINDUP_DIRS.RIGHT
      swordTargetPos = d.pos.clone()
      swordTargetRot = d.rot.clone()
    } else if (phase === 'RELEASE') {
      const d = SWING_RELEASE_DIRS[key] ?? SWING_RELEASE_DIRS.RIGHT
      swordTargetPos = d.pos.clone()
      swordTargetRot = d.rot.clone()
    } else if (phase === 'BLOCKED') {
      // Golpe rechazado: hoja desviada (parada en el choque de espadas)
      swordTargetPos = fpSwordPos(0.12, -0.15, -0.58)
      swordTargetRot = new THREE.Euler(rad(-3), rad(16), rad(-20))
    } else {
      // IDLE / RECOVERY → volver a guardia fija; ampliado el boost para el retorno lento
      swordTargetPos = SWING_REST.pos.clone()
      swordTargetRot = SWING_REST.rot.clone()
      swordStrikeBoostUntil = now + 0.45
    }
  }

  // Predicción local inmediata: reacciona al input sin esperar snapshot del servidor.
  // Threshold en px de movimiento acumulado para confirmar dirección (mismo que useInput).
  const SWING_THRESHOLD = 35

  function setSwordFromInput(isLeftHeld: boolean, isRightHeld: boolean, dir: string, magnitude: number) {
    swordBlockedRigid = false
    if (isRightHeld) {
      if (magnitude >= SWING_THRESHOLD) {
        // Bloqueo con dirección confirmada
        const d = BLOCK_DIRS[dir as keyof typeof BLOCK_DIRS] ?? BLOCK_DIRS.RIGHT
        swordTargetPos = d.pos.clone()
        swordTargetRot = d.rot.clone()
      } else {
        // Pose neutra de guardia: espada adelante, sin dirección aún
        swordTargetPos = fpSwordPos(0.2, -0.15, -0.7)
        swordTargetRot = new THREE.Euler(rad(-9), 0, 0)
      }
    } else if (isLeftHeld) {
      if (magnitude >= SWING_THRESHOLD) {
        const d = SWING_WINDUP_DIRS[dir as keyof typeof SWING_WINDUP_DIRS] ?? SWING_WINDUP_DIRS.RIGHT
        swordTargetPos = d.pos.clone()
        swordTargetRot = d.rot.clone()
      } else {
        // Pose neutra de carga: espada levemente retrasada, sin dirección aún
        swordTargetPos = fpSwordPos(0.4, -0.25, -0.75)
        swordTargetRot = new THREE.Euler(rad(9), rad(-6), 0)
      }
    }
  }

  // ─── Render loop principal ────────────────────────────────────────────────
  function startLoop(onFrame: (dt: number) => void) {
    function loop(now: number) {
      animId = requestAnimationFrame(loop)
      const dt = Math.min((now - lastTime) / 1000, 0.05)
      lastTime = now

      onFrame(dt);
      interpolateRemotes(dt);
      animateSword(dt);
      updateLocalPlayerAvatar();
      updateThirdPersonCamera();
      updateHitBursts(dt);

      // Animación de cuerpo (Locomoción Local)
      const locId = localIdForModels();
      const locMixer = mixers.get(locId);
      if (locMixer) {
        const isLocMoving = Math.abs(lastDx) > 0.1 || Math.abs(lastDz) > 0.1;
        updateMixerState(locMixer, isLocMoving);
      }
      mixers.forEach(m => m.update(dt));

      renderer.render(scene, thirdPerson.value ? cameraThird : camera);

      frameCount++
      fpsTime += dt
      if (fpsTime >= 1) {
        fps.value = Math.round(frameCount / fpsTime)
        frameCount = 0
        fpsTime = 0
      }
    }
    lastTime = performance.now()
    animId = requestAnimationFrame(loop)
  }

  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    cameraThird.aspect = w / h
    cameraThird.updateProjectionMatrix()
  }

  const resizeObs = new ResizeObserver(resize)
  resizeObs.observe(canvas)
  resize()

  onUnmounted(() => {
    cancelAnimationFrame(animId)
    resizeObs.disconnect()
    renderer.dispose()
  })

  return {
    fps,
    localId,
    thirdPerson,
    startLoop,
    pushSnapshot,
    applyLocalMovement,
    applyServerCorrection,
    setSwordAnimation,
    setSwordFromInput,
    toggleThirdPersonView,
    applyHitImpact,
    applyClashImpact,
    loadKayKitAssets,
    refreshCharacterMeshes,
    onWelcome,
    roundTimeLeft,
    localPlayerTeam,
  }
}
