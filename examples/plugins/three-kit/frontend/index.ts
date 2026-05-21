/**
 * Three Kit — frontend runtime.
 *
 * Loaded once per published page (via `frontend.assets`). Scans the DOM
 * for `[data-threekit-type]` elements and boots a Three.js scene inside each
 * one's `<canvas>`. All scenes on a page share a single Three.js instance
 * because we use bare imports (`import * as THREE from 'three'`) — the
 * published page's `<script type="importmap">` resolves those specifiers
 * to host-served `/_pb/runtime/cache/<hash>/three/...` URLs.
 *
 * `pb-plugin build` is configured (via `module.dependencies`) to externalize
 * `three` and `three/*` for this bundle, so these imports stay as bare
 * specifiers in the emitted JS and the browser hits the importmap at runtime.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

type Cleanup = () => void

interface BootedScene {
  cleanup: Cleanup
}

const STAGE_SELECTOR = '[data-threekit-type]'

/**
 * Parse the `data-threekit-options` attribute. The publisher serialises this
 * as JSON inside an HTML-escaped attribute; the browser un-escapes it before
 * we ever touch the string.
 */
function readOptions(el: Element): Record<string, unknown> {
  const raw = el.getAttribute('data-threekit-options')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (err) {
    console.warn('[three-kit] invalid options JSON', err, raw)
  }
  return {}
}

function findCanvas(host: Element): HTMLCanvasElement | null {
  return host.querySelector<HTMLCanvasElement>('canvas')
}

function attachResize(
  canvas: HTMLCanvasElement,
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
): Cleanup {
  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  return () => observer.disconnect()
}

/**
 * Rotating-primitive scene. Geometry kind + color + speed come from the
 * module's persisted props bag.
 */
function bootScene(canvas: HTMLCanvasElement, opts: Record<string, unknown>): Cleanup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(asString(opts.background, '#0f172a'))

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(0, 0, asNumber(opts.cameraDistance, 4.5))

  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  const directional = new THREE.DirectionalLight(0xffffff, 1.4)
  directional.position.set(3, 4, 5)
  scene.add(directional)

  const kind = asString(opts.geometry, 'cube')
  const geometry = geometryFor(kind)
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(asString(opts.color, '#22d3ee')),
    metalness: 0.4,
    roughness: 0.35,
    flatShading: kind === 'cube',
  })
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  const cleanupResize = attachResize(canvas, renderer, camera)

  const speed = asNumber(opts.speed, 0.6)
  let raf = 0
  let running = true
  const tick = (t: number) => {
    if (!running) return
    const s = speed * 0.001
    mesh.rotation.x = t * s * 0.6
    mesh.rotation.y = t * s
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    running = false
    cancelAnimationFrame(raf)
    cleanupResize()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
  }
}

function geometryFor(kind: string): THREE.BufferGeometry {
  switch (kind) {
    case 'sphere': return new THREE.SphereGeometry(1.1, 48, 32)
    case 'torus':  return new THREE.TorusGeometry(0.95, 0.32, 24, 80)
    case 'cone':   return new THREE.ConeGeometry(1.1, 1.8, 48)
    case 'cube':
    default:       return new THREE.BoxGeometry(1.5, 1.5, 1.5)
  }
}

/**
 * Drifting particle cloud — single `THREE.Points` buffer.
 */
function bootParticles(canvas: HTMLCanvasElement, opts: Record<string, unknown>): Cleanup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(asString(opts.background, '#020617'))

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
  camera.position.set(0, 0, 30)

  const count = Math.max(100, Math.min(80_000, asNumber(opts.count, 6000) | 0))
  const radius = asNumber(opts.spread, 36)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const r = Math.cbrt(Math.random()) * radius
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos((Math.random() * 2) - 1)
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const material = new THREE.PointsMaterial({
    color: new THREE.Color(asString(opts.color, '#e2e8f0')),
    size: asNumber(opts.size, 0.08),
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
  })
  const points = new THREE.Points(geometry, material)
  scene.add(points)

  const cleanupResize = attachResize(canvas, renderer, camera)
  const speed = asNumber(opts.speed, 0.4)
  let raf = 0
  let running = true
  const tick = (t: number) => {
    if (!running) return
    points.rotation.y = t * 0.0001 * speed
    points.rotation.x = Math.sin(t * 0.00005 * speed) * 0.2
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    running = false
    cancelAnimationFrame(raf)
    cleanupResize()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
  }
}

/**
 * Rotating textured "3D text" panel. Renders the text to a CanvasTexture so
 * we don't need an async font loader.
 */
function bootText(canvas: HTMLCanvasElement, opts: Record<string, unknown>): Cleanup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(asString(opts.background, '#0f172a'))

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 0, 7)

  scene.add(new THREE.AmbientLight(0xffffff, 0.85))
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(2, 3, 5)
  scene.add(key)

  const texture = buildTextTexture(
    asString(opts.text, 'Three.js'),
    asString(opts.color, '#f8fafc'),
    renderer,
  )
  const textAspect = 1024 / 256
  const height = 1.6
  const geometry = new THREE.BoxGeometry(
    height * textAspect,
    height,
    asNumber(opts.depth, 0.18),
  )

  const sideColor = new THREE.Color(asString(opts.sideColor, asString(opts.color, '#22d3ee')))
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: sideColor,
    metalness: 0.55,
    roughness: 0.35,
  })
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    metalness: 0.1,
    roughness: 0.6,
  })
  const mesh = new THREE.Mesh(geometry, [
    sideMaterial, sideMaterial, sideMaterial, sideMaterial, faceMaterial, faceMaterial,
  ])
  scene.add(mesh)

  const cleanupResize = attachResize(canvas, renderer, camera)
  const speed = asNumber(opts.speed, 0.5)
  let raf = 0
  let running = true
  const tick = (t: number) => {
    if (!running) return
    mesh.rotation.y = Math.sin(t * 0.0006 * speed) * 0.6
    mesh.rotation.x = Math.sin(t * 0.0004 * speed) * 0.15
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    running = false
    cancelAnimationFrame(raf)
    cleanupResize()
    geometry.dispose()
    sideMaterial.dispose()
    faceMaterial.dispose()
    texture.dispose()
    renderer.dispose()
  }
}

function buildTextTexture(text: string, color: string, renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const dpr = 2
  const w = 1024
  const h = 256
  const off = document.createElement('canvas')
  off.width = w * dpr
  off.height = h * dpr
  const ctx = off.getContext('2d')
  if (!ctx) throw new Error('[three-kit] 2D context unavailable')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = color
  ctx.font = '700 144px Inter, system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2)
  const texture = new THREE.CanvasTexture(off)
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
  texture.needsUpdate = true
  return texture
}

/**
 * glTF model viewer with OrbitControls. URL must be CORS-allowed by the
 * remote host or proxied through `'self'` so it loads under the page CSP.
 */
function bootModelViewer(canvas: HTMLCanvasElement, opts: Record<string, unknown>): Cleanup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(asString(opts.background, '#0f172a'))

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000)
  camera.position.set(2.5, 1.8, 2.5)

  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(3, 5, 4)
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0xbfdbfe, 0.4)
  fill.position.set(-3, 2, -2)
  scene.add(fill)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.autoRotate = asBoolean(opts.autoRotate, true)
  controls.autoRotateSpeed = asNumber(opts.autoRotateSpeed, 1.5)
  controls.target.set(0, 0, 0)

  let activeModel: THREE.Object3D | null = null
  const loader = new GLTFLoader()
  const url = asString(opts.url, '')
  if (url) {
    loader.load(
      url,
      (gltf) => {
        const root = gltf.scene
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const scale = 1.8 / maxDim
        root.position.sub(center.multiplyScalar(scale))
        root.scale.setScalar(scale)
        scene.add(root)
        activeModel = root
      },
      undefined,
      (err) => { console.warn('[three-kit] glTF load failed', err) },
    )
  }

  const cleanupResize = attachResize(canvas, renderer, camera)
  let raf = 0
  let running = true
  const tick = () => {
    if (!running) return
    controls.update()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    running = false
    cancelAnimationFrame(raf)
    cleanupResize()
    controls.dispose()
    if (activeModel) {
      activeModel.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.()
          const m = mesh.material
          if (Array.isArray(m)) m.forEach((mm) => mm?.dispose?.())
          else m?.dispose?.()
        }
      })
    }
    renderer.dispose()
  }
}

/**
 * Animated wave-plane hero. Vertex shader does cheap per-vertex sine
 * displacement so the GPU does all the work.
 */
function bootHeroBackground(canvas: HTMLCanvasElement, opts: Record<string, unknown>): Cleanup {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(asString(opts.background, '#020617'))

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 1.8, 4.2)
  camera.lookAt(0, 0, 0)

  const colorA = new THREE.Color(asString(opts.colorA, '#22d3ee'))
  const colorB = new THREE.Color(asString(opts.colorB, '#a855f7'))

  const geometry = new THREE.PlaneGeometry(12, 6, 96, 48)
  geometry.rotateX(-Math.PI / 2.4)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime:   { value: 0 },
      uAmp:    { value: asNumber(opts.amplitude, 0.55) },
      uFreq:   { value: asNumber(opts.frequency, 0.8) },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uAmp;
      uniform float uFreq;
      varying vec3 vPos;
      void main() {
        vec3 p = position;
        p.y += sin((p.x * uFreq) + uTime * 1.2) * uAmp;
        p.y += sin((p.z * uFreq * 1.3) + uTime * 0.8) * uAmp * 0.6;
        vPos = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying vec3 vPos;
      void main() {
        float mixT = clamp(0.5 + vPos.y * 0.6, 0.0, 1.0);
        vec3 c = mix(uColorA, uColorB, mixT);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    wireframe: asBoolean(opts.wireframe, true),
  })

  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  const cleanupResize = attachResize(canvas, renderer, camera)
  const speed = asNumber(opts.speed, 0.7)
  let raf = 0
  let running = true
  const tick = (t: number) => {
    if (!running) return
    material.uniforms.uTime.value = t * 0.001 * speed
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    running = false
    cancelAnimationFrame(raf)
    cleanupResize()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const BOOT_BY_TYPE: Record<string, (canvas: HTMLCanvasElement, opts: Record<string, unknown>) => Cleanup> = {
  scene: bootScene,
  particles: bootParticles,
  text: bootText,
  'model-viewer': bootModelViewer,
  'hero-background': bootHeroBackground,
}

/**
 * Idempotent boot. Each element keeps a marker (`data-threekit-mounted`) so
 * subsequent calls — e.g. after a SPA navigation that re-runs the script —
 * skip already-booted instances.
 */
function bootAll(root: ParentNode): BootedScene[] {
  const scenes: BootedScene[] = []
  const elements = root.querySelectorAll<HTMLElement>(STAGE_SELECTOR)
  for (const el of elements) {
    if (el.dataset.threekitMounted === 'true') continue
    const type = el.dataset.threekitType ?? ''
    const boot = BOOT_BY_TYPE[type]
    if (!boot) continue
    const canvas = findCanvas(el)
    if (!canvas) {
      console.warn('[three-kit] stage missing <canvas>', el)
      continue
    }
    try {
      const cleanup = boot(canvas, readOptions(el))
      el.dataset.threekitMounted = 'true'
      scenes.push({ cleanup })
    } catch (err) {
      console.error('[three-kit] boot failed for', type, err)
    }
  }
  return scenes
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bootAll(document) }, { once: true })
  } else {
    bootAll(document)
  }
}
