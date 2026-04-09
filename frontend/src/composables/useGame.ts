import { ref, shallowRef, onUnmounted } from 'vue'
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { useMap } from './useMap'
import { useEffects } from './useEffects'
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

type CharacterTemplates = {
  paladin: THREE.Object3D
  guard: THREE.Object3D
  swordPaladin: THREE.Object3D
  swordGuard: THREE.Object3D
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


  // ─── Three.js core ────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0a0c14)
  scene.fog = new THREE.FogExp2(0x0a0c14, 0.012)

  // ─── Map and Effects ──────────────────────────────────────────────────
  const mapControl = useMap(scene, renderer)
  const effects = useEffects(scene)

  const params = new URLSearchParams(window.location.search)
  const isFromPortal = params.get('portal') === 'true'
  const portalRef = params.get('ref') || ''

  function checkPortalCollisions() {
    const playerPos2D = new THREE.Vector2(localX, localZ)

    // Check Exit Portal
    if (mapControl.exitPortal.value) {
      const portalPos2D = new THREE.Vector2(mapControl.exitPortal.value.position.x, mapControl.exitPortal.value.position.z)
      if (playerPos2D.distanceTo(portalPos2D) < 2.5) {
        console.log("🚀 Entrando al Portal de Vibe Jam...")
        const url = new URL('https://jam.pieter.com/portal/2026')
        const snap = localSnapshot.value
        const p = snap?.players.find(rp => rp.id === localId.value)

        url.searchParams.set('username', 'Player')
        url.searchParams.set('color', localPlayerTeam.value === 'BARBARIAN' ? 'red' : 'blue')
        url.searchParams.set('speed', '6')
        url.searchParams.set('ref', window.location.origin)
        if (p) {
          url.searchParams.set('hp', p.health.toString())
        }

        window.location.href = url.toString()
      }
    }

    // Check Start Portal (to go back)
    if (mapControl.startPortal.value && portalRef) {
      const portalPos2D = new THREE.Vector2(mapControl.startPortal.value.position.x, mapControl.startPortal.value.position.z)
      if (playerPos2D.distanceTo(portalPos2D) < 2.5) {
        console.log("🔙 Volviendo al juego anterior...")
        const target = portalRef.startsWith('http') ? portalRef : `https://${portalRef}`
        const url = new URL(target)
        params.forEach((val, key) => {
          if (key !== 'portal' && key !== 'ref') url.searchParams.set(key, val)
        })
        window.location.href = url.toString()
      }
    }
  }

  mapControl.updateSky()

  // ─── Camera ─────────────────────────────────────────────────────────────

  const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 200)
  const cameraThird = new THREE.PerspectiveCamera(62, canvas.clientWidth / canvas.clientHeight, 0.1, 200)
  const thirdPerson = ref(true)
  const tpCamBack = 3.55
  const tpCamRaise = 1.22
  const fwScratch = new THREE.Vector3()
  const _mInvAvatar = new THREE.Matrix4()
  const _mSwordLocal = new THREE.Matrix4()

  const ambient = new THREE.AmbientLight(0xfff3e0, 1.2)
  scene.add(ambient)

  const skyFill = new THREE.HemisphereLight(0x6688cc, 0x443300, 1.8)
  scene.add(skyFill)

  mapControl.buildArena(WORLD_SIZE_W, WORLD_SIZE_D)

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
  type SharedClips = {
    idle: THREE.AnimationClip | null
    walk: THREE.AnimationClip | null
    run: THREE.AnimationClip | null
  }
  const guardClips: SharedClips = { idle: null, walk: null, run: null }
  const paladinClips: SharedClips = { idle: null, walk: null, run: null }
  let characterTemplates: CharacterTemplates | null = null
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
    mapControl.ground.geometry.dispose()
    mapControl.ground.geometry = new THREE.PlaneGeometry(w, d)
    mapControl.groundTex.repeat.set(w / 8, d / 8)

    // Reconstruir arena
    mapControl.buildArena(w, d)
    mapControl.setupPortals(w, isFromPortal, portalRef)
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
  // y: +es hacia la derecha, - es hacia la izquierda
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

    // Hoja (doble grosor y +20% largo: 1.32 * 1.2 ≈ 1.58)
    const bladeGeo = new THREE.BoxGeometry(0.12, 1.58, 0.12)
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1.0,
      roughness: 0.15,
      envMapIntensity: 1.0
    })
    const blade = new THREE.Mesh(bladeGeo, bladeMat)
    blade.position.y = 0.79
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

  function playerVariant(team: string): 'guard' | 'paladin' {
    return team === 'BARBARIAN' ? 'paladin' : 'guard'
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

  function applyCharacterBody(body: THREE.Group, playerId: string, team: string, proceduralTint: number) {
    body.clear()
    if (!characterTemplates) {
      fillProceduralBody(body, proceduralTint)
      return
    }
    const v = playerVariant(team)
    const tpl = v === 'guard' ? characterTemplates.guard : characterTemplates.paladin
    const c = cloneSkinned(tpl)
    c.rotateY(KAYKIT_BODY_YAW_OFFSET)
    body.add(c)

    // Configurar Animación
    const clips = v === 'guard' ? guardClips : paladinClips
    if (clips.idle) {
      const mixer = new THREE.AnimationMixer(c)
      mixers.set(playerId, mixer)
      // Forzar estado inicial IDLE
      updateMixerState(mixer, 0, clips)
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
    const team = localPlayerTeam.value || 'KNIGHT'
    const tint = team === 'BARBARIAN' ? 0x8b2020 : 0x3a6b8e
    applyCharacterBody(characterBody, localIdForModels(), team, tint)

    const swordAv = new THREE.Group()
    swordAv.name = 'sword'
    mountKayKitSword(swordAv, localIdForModels())
    group.add(swordAv)

    return group
  }

  const localPlayerAvatar = buildLocalPlayerAvatar()
  localPlayerAvatar.visible = false
  scene.add(localPlayerAvatar)

  async function loadCharacterAssets(): Promise<void> {
    const texLoader = new THREE.TextureLoader()
    const fbx = new FBXLoader()
    const gltfLoader = new GLTFLoader()
    const url = (f: string) => `${KAYKIT_BASE}${f}`

    const [guardGltf, paladinGltf] = await Promise.all([
      gltfLoader.loadAsync('/models/blender/guard1.glb'),
      gltfLoader.loadAsync('/models/blender/paladin.glb')
    ])

    const guardMesh = guardGltf.scene
    const paladinMesh = paladinGltf.scene

    // Configurar color de texturas para GLB (evitar que se vean oscuros o sin textura)
    const setupGLB = (scene: THREE.Object3D) => {
      scene.traverse((node: any) => {
        if (node.isMesh) {
          if (node.material) {
            // Asegurar que las texturas usen el espacio de color correcto
            if (node.material.map) {
              node.material.map.colorSpace = THREE.SRGBColorSpace
              node.material.map.needsUpdate = true
            }

            // Los modelos de Blender suelen venir con metalness al máximo
            // Sin un Environment Map, esto se ve negro.
            if (node.material.isMeshStandardMaterial || node.material.isMeshPhysicalMaterial) {
              if (node.material.metalness > 0) {
                node.material.metalness = 0.2 // Reducir metalness para visibilidad básica
              }
              node.material.roughness = Math.max(node.material.roughness, 0.4)
            }

            // Forzar que los materiales sean opacos si no tienen mapa de opacidad
            node.material.transparent = false
            node.material.alphaTest = 0.5
            node.material.depthWrite = true
          }
        }
      })
    }
    setupGLB(guardMesh)
    setupGLB(paladinMesh)

    // --- ANIMACIONES (Mixamo Rig) ---
    const cleanClips = (gltfClips: THREE.AnimationClip[], target: SharedClips) => {
      const findClip = (namePart: string) => {
        const lowerName = namePart.toLowerCase();

        // 1. PRIORIDAD: Búsqueda exacta del nombre confirmado por el usuario
        const exact = gltfClips.find(a => a.name.toLowerCase() === lowerName);
        if (exact) console.log(`[AssetLoader] findClip('${namePart}') -> Found: ${exact.name}`);
        return exact || null;
      }

      target.idle = findClip('idle')
      target.walk = findClip('walk')
      target.run = findClip('run')

      // Limpieza de tracks Mixamo para evitar T-Pose
      Object.values(target).forEach(clip => {
        if (!clip) return
        clip.tracks.forEach(track => {
          if (track.name.includes('mixamorig')) {
            const parts = track.name.split('mixamorig')
            track.name = 'mixamorig' + parts[parts.length - 1]
          }
        })
      })
    }

    cleanClips(guardGltf.animations, guardClips)
    cleanClips(paladinGltf.animations, paladinClips)

    const paladinMeshFinal = paladinMesh
    const guardMeshFinal = guardMesh

    enableShadows(paladinMeshFinal)
    normalizeCharacterHeight(paladinMeshFinal, PLAYER_HEIGHT)
    enableShadows(guardMeshFinal)
    normalizeCharacterHeight(guardMeshFinal, PLAYER_HEIGHT)

    characterTemplates = {
      paladin: paladinMeshFinal,
      guard: guardMeshFinal,
      swordPaladin: new THREE.Group(),
      swordGuard: new THREE.Group()
    };

    refreshCharacterMeshes()
  }

  function refreshCharacterMeshes() {
    const lid = localIdForModels()
    mountKayKitSword(swordGroup, lid)

    const team = localPlayerTeam.value || 'KNIGHT'
    const tint = team === 'BARBARIAN' ? 0x8b2020 : 0x3a6b8e
    const locBody = localPlayerAvatar.getObjectByName('characterBody') as THREE.Group | undefined
    if (locBody) applyCharacterBody(locBody, lid, team, tint)

    const locSword = localPlayerAvatar.getObjectByName('sword') as THREE.Group | undefined
    if (locSword) {
      mountKayKitSword(locSword, lid)
      locSword.position.set(0, 0, 0)
      locSword.scale.setScalar(1)
    }

    remoteMeshes.forEach((mesh, id) => {
      const b = mesh.getObjectByName('characterBody') as THREE.Group | undefined
      const s = mesh.getObjectByName('sword') as THREE.Group | undefined
      const team = mesh.userData.team || 'BARBARIAN'
      const tint = team === 'BARBARIAN' ? 0x8b2020 : 0x3a6b8e
      if (b) applyCharacterBody(b, id, team, tint)
      if (s) {
        mountKayKitSword(s, id)
        s.position.copy(fpSwordPos(0.4, 0.8, 0.1))
        s.scale.setScalar(0.85)
      }
    })
  }

  function applyHitImpact(x: number, y: number, z: number) {
    effects.applyHitImpact(x, y, z)
  }

  function applyClashImpact(x: number, y: number, z: number) {
    effects.applyClashImpact(x, y, z)
  }

  function getOrCreateRemoteMesh(id: string, team: string): THREE.Group {
    if (remoteMeshes.has(id)) {
      const mesh = remoteMeshes.get(id)!
      if (mesh.userData.team !== team) {
        mesh.userData.team = team
        const b = mesh.getObjectByName('characterBody') as THREE.Group | undefined
        const tint = team === 'BARBARIAN' ? 0x8b2020 : 0x3a6b8e
        if (b) applyCharacterBody(b, id, team, tint)
      }
      return mesh
    }
    const group = new THREE.Group()
    group.userData.team = team

    const characterBody = new THREE.Group()
    characterBody.name = 'characterBody'
    group.add(characterBody)
    const tint = team === 'BARBARIAN' ? 0x8b2020 : 0x3a6b8e
    applyCharacterBody(characterBody, id, team, tint)

    const swordRemote = new THREE.Group()
    swordRemote.name = 'sword'
    swordRemote.position.copy(fpSwordPos(0.4, 0.8, 0.1))
    swordRemote.scale.setScalar(0.85)
    mountKayKitSword(swordRemote, id)
    group.add(swordRemote)

    // Barra de vida flotante
    const barGroup = mapControl.buildHealthBar()
    barGroup.position.y = 2.1
    barGroup.name = 'healthBar'
    group.add(barGroup)

    scene.add(group)
    remoteMeshes.set(id, group)
    return group
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
    localY = me.health <= 0 ? 0.3 : me.y
  }

  // ─── Interpolación de jugadores remotos ──────────────────────────────────
  function pushSnapshot(snap: WorldSnapshot) {
    if (snap.roundTimeLeft !== undefined) roundTimeLeft.value = snap.roundTimeLeft

    if (snap.worldObjects) {
      const camPos = thirdPerson.value ? cameraThird.position : camera.position
      mapControl.updateDestructibleObjects(snap.worldObjects, camPos)
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

      const rp = pAfter ?? pBefore!
      const mesh = getOrCreateRemoteMesh(id, rp.team)
      mesh.visible = true

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

      const isDead = health <= 0
      if (isDead) {
        // Efecto visual de muerte: tumbado en el suelo
        mesh.rotation.x = Math.PI / 2
        mesh.position.y = 0.15
        updateRemoteHealthBar(mesh, 0, maxHealth)
        // Ocultar barra de vida si está muerto
        const bar = mesh.getObjectByName('healthBar')
        if (bar) bar.visible = false
      } else {
        mesh.rotation.x = 0
        mesh.position.y = ty
        updateRemoteHealthBar(mesh, health, maxHealth)
        const bar = mesh.getObjectByName('healthBar')
        if (bar) bar.visible = true
      }

      // Animación de espada: usar el snapshot más reciente disponible
      if (rp && !isDead) {
        animateRemoteSword(mesh, rp.swingPhase, rp.swingDir, rp.blocking, rp.blockDir, dt)
      }

      // Animación de cuerpo (Locomoción)
      const mixer = mixers.get(id)
      const v = playerVariant(rp?.team || 'BARBARIAN')
      const clips = v === 'guard' ? guardClips : paladinClips

      if (mixer && clips.walk && clips.idle && clips.run && !isDead) {
        const span = after && before ? (after.receivedAt - before.receivedAt) : 0
        const distSq = pBefore && pAfter ?
          (Math.pow(pAfter.x - pBefore.x, 2) + Math.pow(pAfter.z - pBefore.z, 2)) : 0

        // Calcular velocidad real (m/s) más estable
        // math.min(10) para evitar picos de red / teleports que disparen animaciones de carrera
        const vel = (span > 0) ? Math.min(10, Math.sqrt(distSq) / (span / 1000)) : 0
        updateMixerState(mixer, vel, clips)
      } else if (mixer && isDead) {
        mixer.stopAllAction()
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

  function updateMixerState(mixer: THREE.AnimationMixer, velocity: number, clips: SharedClips) {
    if (!clips.idle) return
    const targetAction = mixer.clipAction(clips.idle)

    // Solo IDLE por ahora para depurar
    targetAction.enabled = true
    targetAction.setEffectiveTimeScale(1)
    targetAction.setEffectiveWeight(1)
    if (!targetAction.isRunning()) targetAction.play()
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
      effects.updateHitBursts(dt);
      checkPortalCollisions();

      // Animar portales (giro suave)
      mapControl.portalGroup.children.forEach(p => {
        p.rotation.y += dt
        p.children.forEach(child => {
          if (child.userData.speed) child.position.y += Math.sin(performance.now() * 0.005 * child.userData.speed) * 0.005
        })
      })

      // Animación de cuerpo (Locomoción Local)
      const locId = localIdForModels();
      let locMixer = mixers.get(locId);
      if (!locMixer) locMixer = mixers.get('__preview__'); // Fallback por si el ID cambió

      if (locMixer) {
        const vel = Math.sqrt(lastDx * lastDx + lastDz * lastDz) * MOVE_SPEED;
        // Log para ver si el sistema detecta movimiento
        if (vel > 0.01) console.log(`[Input Check] Velocidad detectada: ${vel.toFixed(2)}`);

        const v = playerVariant(localPlayerTeam.value || 'KNIGHT');
        const clips = v === 'guard' ? guardClips : paladinClips;
        updateMixerState(locMixer, vel, clips);
      } else if (frameCount % 60 === 0 && localId.value) {
        // Log cada 60 frames si no encontramos el mixer local
        console.warn(`[Anim] No se encontró mixer para localId: ${locId}. Disponibles:`, Array.from(mixers.keys()));
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
  loadCharacterAssets()

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
    loadCharacterAssets,
    refreshCharacterMeshes,
    onWelcome,
    roundTimeLeft,
    localPlayerTeam,
  }
}
