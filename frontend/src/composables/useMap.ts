import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { ref, shallowRef } from 'vue'

export function useMap(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  const destructibleMeshes = new Map<string, THREE.Group>()
  const texLoader = new THREE.TextureLoader()

  // Texturas de Estructuras
  const groundTex = texLoader.load('/textures/ground.png')
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  groundTex.colorSpace = THREE.SRGBColorSpace

  const castleTex = texLoader.load('/textures/stone_bricks.png')
  castleTex.wrapS = castleTex.wrapT = THREE.RepeatWrapping
  castleTex.colorSpace = THREE.SRGBColorSpace

  const wallTex = texLoader.load('/textures/wall_stone.png')
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping
  wallTex.colorSpace = THREE.SRGBColorSpace

  const barkTex = texLoader.load('/textures/bark.png')
  barkTex.wrapS = barkTex.wrapT = THREE.RepeatWrapping
  barkTex.colorSpace = THREE.SRGBColorSpace

  // Cielo y Sol
  const sky = new Sky()
  sky.scale.setScalar(450000)
  scene.add(sky)

  const sunPosition = new THREE.Vector3()
  const sun = new THREE.DirectionalLight(0xffddaa, 3.5)
  sun.position.set(60, 100, 40)
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

  function updateSky() {
    const uniforms = sky.material.uniforms;
    uniforms['turbidity'].value = 10;
    uniforms['rayleigh'].value = 3;
    uniforms['mieCoefficient'].value = 0.005;
    uniforms['mieDirectionalG'].value = 0.7;

    const phi = THREE.MathUtils.degToRad(5);
    const theta = THREE.MathUtils.degToRad(0);
    sunPosition.setFromSphericalCoords(1, phi, theta);
    uniforms['sunPosition'].value.copy(sunPosition);
    sun.position.copy(sunPosition).multiplyScalar(100)
  }

  // Terreno
  const groundGeo = new THREE.PlaneGeometry(80, 160)
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 0.9,
    metalness: 0,
    color: 0xffffff
  })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  // Portales
  const portalGroup = new THREE.Group()
  scene.add(portalGroup)
  const exitPortal = shallowRef<THREE.Group | null>(null)
  const startPortal = shallowRef<THREE.Group | null>(null)

  function createPortalVisual(color: number): THREE.Group {
    const group = new THREE.Group()
    const ringGeo = new THREE.TorusGeometry(1.5, 0.1, 16, 32)
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    group.add(ring)

    const discGeo = new THREE.CircleGeometry(1.4, 32)
    const discMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    const disc = new THREE.Mesh(discGeo, discMat)
    group.add(disc)

    for (let i = 0; i < 8; i++) {
      const pGeo = new THREE.SphereGeometry(0.05, 4, 4)
      const pMat = new THREE.MeshBasicMaterial({ color })
      const p = new THREE.Mesh(pGeo, pMat)
      p.position.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.5)
      p.userData.speed = 0.5 + Math.random()
      group.add(p)
    }
    return group
  }

  function setupPortals(WORLD_SIZE_W: number, isFromPortal: boolean, portalRef: string) {
    portalGroup.clear()
    exitPortal.value = createPortalVisual(0xff33aa)
    exitPortal.value.position.set(WORLD_SIZE_W / 2 - 3, 2.2, 0)
    exitPortal.value.rotation.y = -Math.PI / 2
    portalGroup.add(exitPortal.value)

    if (isFromPortal && portalRef) {
      startPortal.value = createPortalVisual(0x33aaff)
      startPortal.value.position.set(-WORLD_SIZE_W / 2 + 3, 2.2, 0)
      startPortal.value.rotation.y = Math.PI / 2
      portalGroup.add(startPortal.value)
    }
  }

  function buildTree(x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.scale.setScalar(0.7 + Math.random() * 0.4)
    group.rotation.y = Math.random() * Math.PI * 2

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6)
    const tBark = barkTex.clone()
    tBark.repeat.set(2, 2)
    const trunkMat = new THREE.MeshStandardMaterial({
      map: tBark,
      color: 0xffffff,
      roughness: 0.9
    })
    const trunk = new THREE.Mesh(trunkGeo, trunkMat)
    trunk.position.y = 1.5
    trunk.castShadow = true
    trunk.receiveShadow = true
    group.add(trunk)

    const fTex = texLoader.load('/textures/foliage.png')
    fTex.colorSpace = THREE.SRGBColorSpace
    const fMat = new THREE.MeshStandardMaterial({
      map: fTex,
      color: 0x1a4a1a,
      roughness: 1,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide
    })

    const leafGeo = new THREE.PlaneGeometry(2.5, 2.5)
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(leafGeo, fMat)
      const h = 2.0 + Math.random() * 3.5
      const r = 0.5 + Math.random() * 1.5
      const angle = Math.random() * Math.PI * 2
      m.position.set(Math.cos(angle) * r, h, Math.sin(angle) * r)
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0)
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }
    scene.add(group)
  }

  function buildArena(WORLD_SIZE_W: number, WORLD_SIZE_D: number) {
    scene.children.filter(c => c.userData.isWall).forEach(c => scene.remove(c))
    const hW = WORLD_SIZE_W / 2
    const hD = WORLD_SIZE_D / 2

    const wallConfigs = [
      { x: 0, z: -hD, rx: 0, w: WORLD_SIZE_W, h: 10 },
      { x: hW, z: 0, rx: Math.PI / 2, w: WORLD_SIZE_D, h: 10 },
      { x: 0, z: hD, rx: Math.PI, w: WORLD_SIZE_W, h: 10 },
      { x: -hW, z: 0, rx: -Math.PI / 2, w: WORLD_SIZE_D, h: 10 },
    ]
    wallConfigs.forEach(({ x, z, rx, w, h }) => {
      const geo = new THREE.BoxGeometry(w, h, 2)
      const t = wallTex.clone()
      t.repeat.set(w / 4, h / 4)
      t.needsUpdate = true
      const mat = new THREE.MeshStandardMaterial({ map: t, color: 0x888888, roughness: 0.8, metalness: 0.2 })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, h / 2 - 0.2, z)
      mesh.rotation.y = rx
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.isWall = true
      scene.add(mesh)
    })

    const treePositions = [[12, 12], [-12, 12], [12, -12], [-12, -12], [22, 0], [-22, 0], [0, 22], [0, -22]]
    treePositions.forEach(([x, z]) => buildTree(x, z))
  }

  function buildHealthBar(): THREE.Group {
    const g = new THREE.Group()
    const bgGeo = new THREE.PlaneGeometry(1.0, 0.12)
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x330000, depthTest: false, transparent: true, opacity: 0.7 })
    const bg = new THREE.Mesh(bgGeo, bgMat)
    bg.name = 'hpBg'
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

  function buildDestructibleModel(obj: any): THREE.Group {
    const group = new THREE.Group()
    const isCastle = obj.type === 'CASTLE'
    const tex = isCastle ? castleTex.clone() : wallTex.clone()
    tex.repeat.set(obj.width / 3, isCastle ? 4 : 2)
    tex.needsUpdate = true
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: isCastle ? 0xffffff : 0xaaaaaa, metalness: 0.2, roughness: 0.7 })

    if (isCastle) {
      const keepGeo = new THREE.BoxGeometry(obj.width, 14, obj.depth)
      const keep = new THREE.Mesh(keepGeo, mat); keep.position.y = 7; keep.castShadow = true; keep.receiveShadow = true; group.add(keep)
      const tw = obj.width * 0.25, th = 18
      const towerGeo = new THREE.BoxGeometry(tw, th, tw)
      const corners = [[obj.width / 2, obj.depth / 2], [-obj.width / 2, obj.depth / 2], [obj.width / 2, -obj.depth / 2], [-obj.width / 2, -obj.depth / 2]]
      corners.forEach(([cx, cz]) => {
        const tower = new THREE.Mesh(towerGeo, mat.clone()); tower.position.set(cx, th / 2, cz); tower.castShadow = true; tower.receiveShadow = true; group.add(tower)
      })
      const toothGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2)
      for (let x = -obj.width / 2; x <= obj.width / 2; x += 2.5) {
        const t1 = new THREE.Mesh(toothGeo, mat.clone()); t1.position.set(x, 14.5, obj.depth / 2); group.add(t1)
        const t2 = new THREE.Mesh(toothGeo, mat.clone()); t2.position.set(x, 14.5, -obj.depth / 2); group.add(t2)
      }
    } else {
      const wallGeo = new THREE.BoxGeometry(obj.width, 6, obj.depth)
      const wall = new THREE.Mesh(wallGeo, mat); wall.position.y = 3; wall.castShadow = true; wall.receiveShadow = true; group.add(wall)
      const toothGeo = new THREE.BoxGeometry(1.2, 1.2, obj.depth + 0.2)
      for (let x = -obj.width / 2; x <= obj.width / 2; x += 2.2) {
        const tooth = new THREE.Mesh(toothGeo, mat.clone()); tooth.position.set(x, 6.2, 0); group.add(tooth)
      }
    }
    group.position.set(obj.x, 0, obj.z)
    const hpBar = buildHealthBar()
    hpBar.name = 'healthBar'; hpBar.position.y = isCastle ? 20 : 8; hpBar.scale.set(5.0, 3.5, 1); group.add(hpBar)
    return group
  }

  function updateDestructibleObjects(worldObjects: any[], cameraPos: THREE.Vector3) {
    worldObjects.forEach((obj: any) => {
      let m = destructibleMeshes.get(obj.id)
      if (!m) {
        m = buildDestructibleModel(obj)
        scene.add(m)
        destructibleMeshes.set(obj.id, m)
      }
      const hpPct = Math.max(0, obj.health / obj.maxHealth)
      m.visible = hpPct > 0
      const bar = m.getObjectByName('healthBar') as THREE.Group | undefined
      if (bar) {
        const fill = bar.getObjectByName('hpFill') as THREE.Mesh | undefined
        if (fill) {
          fill.scale.x = hpPct
          fill.position.x = -(1 - hpPct) / 2
          const mat = fill.material as THREE.MeshBasicMaterial
          mat.color.setHex(hpPct > 0.5 ? 0x22bb22 : hpPct > 0.25 ? 0xffaa00 : 0xcc0000)
        }
        bar.lookAt(cameraPos)
      }
      m.traverse(child => {
        if (child instanceof THREE.Mesh && child.name !== 'hpFill' && child.name !== 'hpBg') {
          if (child.material instanceof THREE.MeshStandardMaterial) {
            const baseColor = obj.type === 'CASTLE' ? 0xffffff : 0xaaaaaa
            child.material.color.setHex(baseColor).multiplyScalar(0.4 + 0.6 * hpPct)
          }
        }
      })
    })

    destructibleMeshes.forEach((mesh, id) => {
      if (!worldObjects.some(o => o.id === id)) {
        scene.remove(mesh)
        destructibleMeshes.delete(id)
      }
    })
  }

  return {
    ground,
    groundTex,
    updateSky,
    buildArena,
    setupPortals,
    portalGroup,
    exitPortal,
    startPortal,
    buildHealthBar,
    updateDestructibleObjects
  }
}
