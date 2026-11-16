/**
 * Otto, KNOQRA's otter, drawn with three.js: one sculpted head on a neck and shoulders, with
 * vertex-blended fur and muzzle and a single-ear operator headset.
 *
 * A port of `packages/brand/reference/otto-head.js` to the npm `three`, without the custom element.
 * Geometry, materials, lighting and motion are unchanged; only the structure and the clean-up are
 * new. Import it lazily (`import('./otto-scene')`) so three lands in its own chunk.
 */
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  CapsuleGeometry,
  CatmullRomCurve3,
  Clock,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LatheGeometry,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { OttoMood } from '../../lib/otto';

export interface OttoSceneOptions {
  /** `head` frames the head alone; `bust` (the reference's default) adds the shoulders. */
  frame: 'head' | 'bust';
  /** Render one frame, swap it for a plain image and free the GPU. */
  still: boolean;
  /** Called once if the browser takes the WebGL context away; the scene has disposed itself. */
  onContextLost?: () => void;
}

export interface OttoScene {
  setMood(mood: OttoMood): void;
  dispose(): void;
}

type Vec3 = readonly [number, number, number];

// The numeric hex colours below are WebGL light and material values, not UI colours, so they are
// a deliberate exception to the design-tokens rule (CSS variables cannot reach the GPU).

const BOOP_MS = 1400;
const IDLE_DRIFT_AFTER_MS = 4000;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Smoothstep. */
const sm = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const SX = 1.06;
const SY = 0.95;
const SZ = 0.97;

/** Radius, cream blend and ear weight of the head surface at a point on the unit sphere. */
function field(x: number, y: number, z: number): { r: number; cream: number; ear: number } {
  const ax = Math.abs(x);
  const front = sm(-0.1, 0.6, z);
  const mz = Math.exp(-((x / 0.4) ** 2 + ((y + 0.3) / 0.27) ** 2)) * sm(0.15, 0.75, z);
  const ch = Math.exp(-(((ax - 0.42) / 0.24) ** 2 + ((y + 0.2) / 0.25) ** 2)) * sm(-0.1, 0.55, z);
  const brow = Math.exp(-(((ax - 0.3) / 0.16) ** 2 + ((y - 0.3) / 0.1) ** 2)) * front;
  const sock = Math.exp(-(((ax - 0.33) / 0.1) ** 2 + ((y - 0.13) / 0.1) ** 2)) * front;
  const ear = Math.exp(-((Math.acos(clamp(ax * 0.78 + y * 0.62 + z * 0.05, -1, 1)) / 0.17) ** 2));
  const chin = Math.exp(-((x / 0.42) ** 2 + ((y + 0.62) / 0.26) ** 2)) * sm(-0.2, 0.5, z);
  return {
    r:
      1 +
      0.27 * mz +
      0.07 * ch +
      0.025 * brow -
      0.03 * sock +
      0.19 * ear +
      0.03 * chin -
      0.05 * sm(0.55, 1, y),
    cream: sm(0.14, 0.5, mz + ch * 0.9 + chin * 1.3),
    ear,
  };
}

/** The point on the head's front surface above (x, y), pushed out by `out`. */
function surf(x: number, y: number, out = 1): Vec3 {
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const r = field(x, y, z).r * out;
  return [x * r * SX, y * r * SY, z * r * SZ];
}

const V = (a: Vec3) => new Vector3(a[0], a[1], a[2]);

function createRenderer(): WebGLRenderer {
  const r = new WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: true,
  });
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  r.outputColorSpace = SRGBColorSpace;
  r.toneMapping = ACESFilmicToneMapping;
  r.toneMappingExposure = 1.02;
  r.domElement.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:pointer;touch-action:manipulation';
  r.domElement.setAttribute('aria-hidden', 'true');
  return r;
}

function createCamera(frame: OttoSceneOptions['frame']): PerspectiveCamera {
  const headOnly = frame === 'head';
  const cam = new PerspectiveCamera(headOnly ? 25 : 30, 1, 0.1, 50);
  if (headOnly) {
    cam.position.set(0, 0.02, 6.4);
    cam.lookAt(0, -0.1, 0);
  } else {
    cam.position.set(0, -0.3, 7.6);
    cam.lookAt(0, -0.5, 0);
  }
  return cam;
}

function addLights(scene: Scene): void {
  scene.add(new HemisphereLight(0xffffff, 0xd2c8b8, 1.15));
  const lights: [number, number, Vec3][] = [
    [0xfff0de, 2.6, [2.6, 3.6, 5]],
    [0xdde7ff, 2.3, [-3.6, 2.4, -4]],
    [0xffffff, 0.5, [-3, -1, 3]],
  ];
  for (const [color, intensity, p] of lights) {
    const light = new DirectionalLight(color, intensity);
    light.position.set(p[0], p[1], p[2]);
    scene.add(light);
  }
}

function createMaterials() {
  const fur = new MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.62,
    sheen: 0.55,
    sheenRoughness: 0.6,
    sheenColor: new Color(0xffe2c4),
  });
  const furBody = fur.clone();
  furBody.side = DoubleSide;
  return {
    fur,
    furBody,
    gloss: new MeshPhysicalMaterial({
      color: 0x17110e,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
    white: new MeshBasicMaterial({ color: 0xffffff }),
    dot: new MeshStandardMaterial({ color: 0x5c3b25, roughness: 0.8 }),
    ink: new MeshStandardMaterial({ color: 0x1d2620, roughness: 0.35, metalness: 0.1 }),
    citron: new MeshStandardMaterial({
      color: 0xc9fa74,
      roughness: 0.3,
      emissive: 0x86b02c,
      emissiveIntensity: 0,
    }),
  };
}
type Materials = ReturnType<typeof createMaterials>;

const BROWN = new Color(0x8a5c3b);
const CREAM = new Color(0xf2e4cf);
const EAR = new Color(0x6b432a);

function headGeometry(): SphereGeometry {
  const hg = new SphereGeometry(1, 160, 120);
  const hp = hg.attributes.position;
  if (!hp) throw new Error('sphere has no positions');
  const colors = new Float32Array(hp.count * 3);
  const tmp = new Color();
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const y = hp.getY(i);
    const z = hp.getZ(i);
    const f = field(x, y, z);
    hp.setXYZ(i, x * f.r * SX, y * f.r * SY, z * f.r * SZ);
    tmp
      .copy(BROWN)
      .lerp(EAR, f.ear * 0.5)
      .lerp(CREAM, f.cream);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  hg.setAttribute('color', new BufferAttribute(colors, 3));
  hg.computeVertexNormals();
  return hg;
}

const BODY_PROFILE: readonly (readonly [number, number])[] = [
  [1.4, -2.8],
  [1.4, -2.3],
  [1.36, -1.92],
  [1.25, -1.62],
  [1.05, -1.37],
  [0.85, -1.13],
  [0.74, -0.9],
  [0.68, -0.68],
  [0.6, -0.5],
  [0.001, -0.4],
];

function bodyGeometry(): LatheGeometry {
  const bg = new LatheGeometry(
    BODY_PROFILE.map(([a, b]) => new Vector2(a, b)),
    120,
  );
  const bp = bg.attributes.position;
  if (!bp) throw new Error('lathe has no positions');
  const colors = new Float32Array(bp.count * 3);
  const tmp = new Color();
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i);
    const y = bp.getY(i);
    const z = bp.getZ(i);
    const rad = Math.max(0.01, Math.hypot(x, z));
    const w = Math.exp(-((x / (0.4 + 0.1 * -y)) ** 2)) * sm(0, 0.8, z / rad);
    tmp.copy(BROWN).lerp(CREAM, sm(0.3, 0.7, w));
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
    const t = sm(-1.45, -0.6, y);
    bp.setZ(i, z * (0.8 + 0.42 * t) + 0.08 * t);
  }
  bg.setAttribute('color', new BufferAttribute(colors, 3));
  bg.computeVertexNormals();
  return bg;
}

/** A sphere mesh at `p`, optionally scaled. */
function sphere(rad: number, m: Material, p: Vec3, s: Vec3 | null = null, seg = 32): Mesh {
  const me = new Mesh(new SphereGeometry(rad, seg, Math.round(seg * 0.75)), m);
  me.position.set(p[0], p[1], p[2]);
  if (s) me.scale.set(s[0], s[1], s[2]);
  return me;
}

/** Places `o` at `p` facing outward from the head's centre. */
function face<T extends Object3D>(o: T, p: Vec3): T {
  o.position.set(p[0], p[1], p[2]);
  o.lookAt(V(p).multiplyScalar(2));
  return o;
}

interface Eye {
  g: Group;
  ball: Mesh;
  h1: Mesh;
  h2: Mesh;
  arc: Mesh;
  base: Vector3;
}

function buildEyes(head: Group, m: Materials): Eye[] {
  return [-1, 1].map((s) => {
    const g = face(new Group(), surf(s * 0.33, 0.14, 0.985));
    const ball = sphere(0.085, m.gloss, [0, 0, 0], [1, 1.16, 0.62]);
    const h1 = sphere(0.026, m.white, [0.026, 0.042, 0.046], null, 16);
    const h2 = sphere(0.011, m.white, [-0.024, -0.03, 0.05], null, 12);
    const arc = new Mesh(new TorusGeometry(0.066, 0.019, 10, 28, Math.PI), m.gloss);
    arc.position.set(0, -0.02, 0.03);
    arc.visible = false;
    g.add(ball, h1, h2, arc);
    head.add(g);
    return { g, ball, h1, h2, arc, base: g.position.clone() };
  });
}

/** Nose, mouth, smile and whisker dots. Returns the mouth and the smile, which swap on mood. */
function buildMuzzle(head: Group, m: Materials): { mouth: Mesh; smile: Mesh } {
  const nose = face(new Group(), surf(0, -0.17, 1));
  nose.add(
    sphere(0.12, m.gloss, [0, 0, 0.005], [1.38, 0.82, 0.78]),
    sphere(0.022, m.white, [-0.035, 0.035, 0.085], [1.5, 0.8, 0.6], 12),
  );
  head.add(nose);
  const curve = (pts: (readonly [number, number])[]) =>
    new Mesh(
      new TubeGeometry(
        new CatmullRomCurve3(pts.map(([x, y]) => V(surf(x, y, 1.012)))),
        48,
        0.014,
        8,
        false,
      ),
      m.gloss,
    );
  const mouth = curve([
    [-0.13, -0.355],
    [-0.065, -0.405],
    [0, -0.37],
    [0.065, -0.405],
    [0.13, -0.355],
  ]);
  const smile = curve([
    [-0.17, -0.34],
    [-0.09, -0.435],
    [0, -0.46],
    [0.09, -0.435],
    [0.17, -0.34],
  ]);
  smile.visible = false;
  head.add(mouth, smile);
  for (const s of [-1, 1]) {
    for (const k of [0, 1, 2]) {
      head.add(sphere(0.012, m.dot, surf(s * (0.17 + k * 0.055), -0.27 - k * 0.022, 1), null, 10));
    }
  }
  return { mouth, smile };
}

/** The single-ear operator headset: ear cup, boom and the citron mic that glows when listening. */
function buildHeadset(head: Group, m: Materials): void {
  const cup = new Mesh(new CapsuleGeometry(0.13, 0.1, 8, 20), m.ink);
  cup.rotation.z = Math.PI / 2;
  cup.position.copy(V(surf(0.95, -0.02, 1))).add(new Vector3(0.04, 0, 0));
  head.add(cup);
  const boom: Vec3[] = [
    [1.04, -0.1, 0.36],
    [1.0, -0.33, 0.62],
    [0.74, -0.5, 0.9],
    [0.42, -0.52, 1.02],
  ];
  head.add(
    new Mesh(new TubeGeometry(new CatmullRomCurve3(boom.map(V)), 40, 0.022, 8, false), m.ink),
  );
  head.add(sphere(0.058, m.citron, [0.4, -0.52, 1.03], [1.25, 1, 1], 20));
}

interface Rig {
  scene: Scene;
  root: Group;
  body: Mesh;
  pivot: Group;
  eyes: Eye[];
  mouth: Mesh;
  smile: Mesh;
  citron: MeshStandardMaterial;
}

function buildRig(): Rig {
  const scene = new Scene();
  addLights(scene);
  const m = createMaterials();
  const root = new Group();
  scene.add(root);
  const body = new Mesh(bodyGeometry(), m.furBody);
  root.add(body);
  const pivot = new Group();
  pivot.position.set(0, -0.55, 0);
  root.add(pivot);
  const head = new Group();
  head.position.set(0, 0.55, 0);
  pivot.add(head);
  head.add(new Mesh(headGeometry(), m.fur));
  const eyes = buildEyes(head, m);
  const { mouth, smile } = buildMuzzle(head, m);
  buildHeadset(head, m);
  return { scene, root, body, pivot, eyes, mouth, smile, citron: m.citron };
}

/** Frees every geometry and material in the scene. */
function disposeScene(scene: Scene): void {
  const materials = new Set<Material>();
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      const m = o.material as Material | Material[];
      for (const each of Array.isArray(m) ? m : [m]) materials.add(each);
    }
  });
  for (const m of materials) m.dispose();
}

interface MotionState {
  yaw: number;
  pitch: number;
  roll: number;
  /** Pointer-driven targets. */
  ty: number;
  tp: number;
  /** When the pointer last moved. */
  last: number;
  t: number;
  blink: number;
  next: number;
  /** Bounce offset and velocity after a boop. */
  b: number;
  bv: number;
  boopUntil: number;
  /** The mood being drawn: the requested one, or happy during a boop. */
  mood: OttoMood;
  ex: number;
  ey: number;
}

/** Moves the rig one step of `dt` seconds towards where the mood and the pointer want it. */
function step(rig: Rig, st: MotionState, dt: number, reduce: boolean): void {
  st.t += dt;
  const m = st.mood;
  const now = performance.now();
  let ty = st.ty;
  let tp = st.tp;
  let tr = 0;
  if (now - st.last > IDLE_DRIFT_AFTER_MS && !reduce) {
    ty = Math.sin(st.t * 0.33) * 0.2;
    tp = Math.sin(st.t * 0.21) * 0.05;
  }
  if (m === 'listening') {
    tr = 0.12;
    tp += 0.03;
  }
  if (m === 'thinking') {
    ty = 0.2 + Math.sin(st.t * 0.6) * 0.04;
    tp = -0.2;
    tr = -0.05;
  }
  const k = 1 - 0.002 ** dt;
  const f = reduce ? 0.5 : 1;
  st.yaw = lerp(st.yaw, ty * f, k);
  st.pitch = lerp(st.pitch, tp * f, k);
  st.roll = lerp(st.roll, tr, k);
  st.bv += (-st.b * 60 - st.bv * 9) * dt;
  st.b += st.bv * dt;
  rig.pivot.rotation.set(st.pitch, st.yaw, st.roll);
  rig.body.rotation.y = st.yaw * 0.25;
  const br = reduce ? 0 : Math.sin(st.t * 1.5) * 0.012;
  rig.root.position.y = br + st.b * 0.08;
  rig.body.scale.set(1 + br * 0.4, 1, 1 + br * 0.4);
  st.ex = lerp(st.ex, m === 'thinking' ? 0.025 : st.ty * 0.04, k);
  st.ey = lerp(st.ey, m === 'thinking' ? 0.03 : -st.tp * 0.03, k);
  stepFace(rig, st, dt, k);
}

/** Blinks, eye and mouth shapes for the mood, and the mic glow. */
function stepFace(rig: Rig, st: MotionState, dt: number, k: number): void {
  st.next -= dt;
  if (st.next <= 0) {
    st.blink = 0.16;
    st.next = 2.4 + Math.random() * 3;
  }
  st.blink = Math.max(0, st.blink - dt);
  const lid = st.blink > 0 ? Math.max(0.1, Math.abs(st.blink - 0.08) / 0.08) : 1;
  const happy = st.mood === 'happy';
  for (const e of rig.eyes) {
    e.g.position.set(e.base.x + st.ex, e.base.y + st.ey, e.base.z);
    e.ball.visible = !happy;
    e.arc.visible = happy;
    e.ball.scale.y = 1.16 * lid;
    const highlights = !happy && lid > 0.5;
    e.h1.visible = highlights;
    e.h2.visible = highlights;
  }
  rig.mouth.visible = !happy;
  rig.smile.visible = happy;
  rig.citron.emissiveIntensity = lerp(
    rig.citron.emissiveIntensity,
    st.mood === 'listening' ? 0.8 : 0,
    k,
  );
}

/**
 * Draws Otto into `host` (which should be positioned and sized; the canvas fills it). Throws when
 * WebGL cannot be started, so the caller can show the still image instead.
 */
export function mountOtto(host: HTMLElement, opts: OttoSceneOptions): OttoScene {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const cam = createCamera(opts.frame);
  const rig = buildRig();
  let r: WebGLRenderer;
  try {
    r = createRenderer();
  } catch (error) {
    disposeScene(rig.scene);
    throw error;
  }
  host.appendChild(r.domElement);
  const clock = new Clock();
  const st: MotionState = {
    yaw: 0,
    pitch: 0,
    roll: 0,
    ty: 0,
    tp: 0,
    last: -1e9,
    t: 0,
    blink: 0,
    next: 1.6,
    b: 0,
    bv: 0,
    boopUntil: 0,
    mood: 'idle',
    ex: 0,
    ey: 0,
  };
  let requested: OttoMood = 'idle';
  let raf = 0;
  let visible = true;
  let disposed = false;
  const cleanups: (() => void)[] = [];

  const resolveMood = () => {
    st.mood = performance.now() < st.boopUntil ? 'happy' : requested;
  };
  const render = (dt: number) => {
    if (st.mood === 'happy' && performance.now() > st.boopUntil) resolveMood();
    step(rig, st, dt, reduce);
    r.render(rig.scene, cam);
  };
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!visible) {
      clock.getDelta();
      return;
    }
    render(Math.min(0.05, clock.getDelta()));
  };
  const fitToHost = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    r.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    render(0.016);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    for (const cleanup of cleanups) cleanup();
    disposeScene(rig.scene);
    const lost = r.getContext().isContextLost();
    r.dispose();
    if (!lost) r.forceContextLoss();
    r.domElement.remove();
  };

  resolveMood();
  fitToHost();

  if (opts.still) {
    const img = new Image();
    img.alt = '';
    img.src = r.domElement.toDataURL('image/png');
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    host.appendChild(img);
    dispose();
    return {
      setMood: () => {},
      dispose: () => img.remove(),
    };
  }

  const onPointer = (e: PointerEvent) => {
    const b = host.getBoundingClientRect();
    st.ty =
      clamp((e.clientX - b.left - b.width / 2) / Math.max(320, window.innerWidth * 0.45), -1, 1) *
      0.5;
    st.tp =
      clamp((e.clientY - b.top - b.height / 2) / Math.max(260, window.innerHeight * 0.45), -1, 1) *
      0.28;
    st.last = performance.now();
  };
  const onBoop = () => {
    st.boopUntil = performance.now() + BOOP_MS;
    st.bv = 3;
    resolveMood();
  };
  const onContextLost = () => {
    dispose();
    opts.onContextLost?.();
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  r.domElement.addEventListener('webglcontextlost', onContextLost);
  r.domElement.addEventListener('click', onBoop);
  cleanups.push(() => {
    window.removeEventListener('pointermove', onPointer);
    r.domElement.removeEventListener('click', onBoop);
    r.domElement.removeEventListener('webglcontextlost', onContextLost);
  });

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    io.observe(host);
    cleanups.push(() => io.disconnect());
  }
  const ro = new ResizeObserver(fitToHost);
  ro.observe(host);
  cleanups.push(() => ro.disconnect());

  raf = requestAnimationFrame(tick);
  return {
    setMood(mood) {
      requested = mood;
      resolveMood();
    },
    dispose,
  };
}
