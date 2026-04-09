import * as THREE from 'three'

export function useEffects(scene: THREE.Scene) {
  let hitAudioCtx: AudioContext | null = null
  const hitBursts: { g: THREE.Group; t: number }[] = []

  function playHitImpactSound(localX: number, localY: number, localZ: number, pos?: THREE.Vector3) {
    try {
      if (!hitAudioCtx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext
        if (AC) hitAudioCtx = new AC()
        else return
      }
      const ctx = hitAudioCtx!
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => { })
      }

      // --- Audio de proximidad ---
      let volume = 0.55
      if (pos) {
        const lPos = new THREE.Vector3(localX, localY, localZ)
        const dist = pos.distanceTo(lPos)
        if (dist > 35) return // No reproducir lejos
        volume = Math.max(0, 0.6 * (1 - dist / 35))
        if (volume < 0.01) return
      }

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
      gn.gain.value = volume
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
      g2.gain.setValueAtTime(0.06 * (volume / 0.55), t0)
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
          ;(mesh.material as THREE.Material).dispose()
        })
        hitBursts.splice(i, 1)
      }
    }
  }

  function applyHitImpact(x: number, y: number, z: number) {
    spawnHitBlood(x, y, z)
  }

  function playClashSound() {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext
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
  }

  return {
    playHitImpactSound,
    spawnHitBlood,
    updateHitBursts,
    applyHitImpact,
    playClashSound,
    spawnClashSparks,
    applyClashImpact
  }
}
