// biome-ignore-all lint: reference source for the M5 port, not part of the build
// biome-ignore-all format: verbatim apart from the two lint-ignore lines above
// <otto-head mood="idle|listening|thinking|happy" frame="bust|head" still> — Otto, KNOQRA's otter, drawn with three.js.
// One continuous sculpted head on a neck and shoulders; vertex-blended fur and muzzle; single-ear operator headset.
(() => {
  if (customElements.get('otto-head')) return;
  const URL3 = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
  let p3 = null;
  const load3 = () => (p3 = p3 || import(URL3));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const SX = 1.06, SY = 0.95, SZ = 0.97;
  const field = (x, y, z) => {
    const ax = Math.abs(x), front = sm(-0.1, 0.6, z);
    const mz = Math.exp(-((x / 0.4) ** 2 + ((y + 0.3) / 0.27) ** 2)) * sm(0.15, 0.75, z);
    const ch = Math.exp(-(((ax - 0.42) / 0.24) ** 2 + ((y + 0.2) / 0.25) ** 2)) * sm(-0.1, 0.55, z);
    const brow = Math.exp(-(((ax - 0.3) / 0.16) ** 2 + ((y - 0.3) / 0.1) ** 2)) * front;
    const sock = Math.exp(-(((ax - 0.33) / 0.1) ** 2 + ((y - 0.13) / 0.1) ** 2)) * front;
    const ear = Math.exp(-((Math.acos(clamp(ax * 0.78 + y * 0.62 + z * 0.05, -1, 1)) / 0.17) ** 2));
    const chin = Math.exp(-((x / 0.42) ** 2 + ((y + 0.62) / 0.26) ** 2)) * sm(-0.2, 0.5, z);
    return { r: 1 + 0.27 * mz + 0.07 * ch + 0.025 * brow - 0.03 * sock + 0.19 * ear + 0.03 * chin - 0.05 * sm(0.55, 1, y), cream: sm(0.14, 0.5, mz + ch * 0.9 + chin * 1.3), ear };
  };
  const surf = (x, y, out = 1) => { const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)), f = field(x, y, z), r = f.r * out; return [x * r * SX, y * r * SY, z * r * SZ]; };

  class Otto extends HTMLElement {
    static get observedAttributes() { return ['mood']; }
    get mood() { return this.getAttribute('mood') || 'idle'; }
    set mood(v) { this.setAttribute('mood', v || 'idle'); }
    attributeChangedCallback() { if (this.st) this.setMood(); }
    connectedCallback() {
      if (this.r3) { if (!this.gone) { this.dead = false; this.loop(); } return; }
      if (this.started) return;
      this.started = true;
      Object.assign(this.style, { display: 'block', position: 'relative' });
      if (!this.style.width) this.style.width = '100%';
      if (!this.style.height) this.style.height = '100%';
      this.setAttribute('role', 'img');
      if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Otto, the KNOQRA assistant');
      load3().then(T => { if (!this.dead) this.build(T); }).catch(() => {});
    }
    disconnectedCallback() { this.dead = true; cancelAnimationFrame(this.raf); if (this.pm) window.removeEventListener('pointermove', this.pm); }
    boop() { if (!this.st) return; this.st.boopUntil = performance.now() + 1400; this.st.bv = 3; this.setMood(); }
    setMood() { this.st.mood = performance.now() < this.st.boopUntil ? 'happy' : this.mood; }
    build(T) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const still = this.hasAttribute('still'), headOnly = this.getAttribute('frame') === 'head';
      let r;
      try { r = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true }); } catch (e) { return; }
      this.r3 = r;
      r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      r.outputColorSpace = T.SRGBColorSpace;
      r.toneMapping = T.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.02;
      r.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:pointer;touch-action:manipulation';
      this.appendChild(r.domElement);

      const scene = new T.Scene();
      const cam = new T.PerspectiveCamera(headOnly ? 25 : 30, 1, 0.1, 50);
      if (headOnly) { cam.position.set(0, 0.02, 6.4); cam.lookAt(0, -0.1, 0); } else { cam.position.set(0, -0.3, 7.6); cam.lookAt(0, -0.5, 0); }
      scene.add(new T.HemisphereLight(0xffffff, 0xd2c8b8, 1.15));
      const L = (c, i, p) => { const l = new T.DirectionalLight(c, i); l.position.set(p[0], p[1], p[2]); scene.add(l); };
      L(0xfff0de, 2.6, [2.6, 3.6, 5]); L(0xdde7ff, 2.3, [-3.6, 2.4, -4]); L(0xffffff, 0.5, [-3, -1, 3]);

      const C = h => new T.Color(h);
      const fur = new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.62, sheen: 0.55, sheenRoughness: 0.6, sheenColor: C(0xffe2c4) });
      const furBody = fur.clone(); furBody.side = T.DoubleSide;
      const gloss = new T.MeshPhysicalMaterial({ color: 0x17110e, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06 });
      const white = new T.MeshBasicMaterial({ color: 0xffffff });
      const dotM = new T.MeshStandardMaterial({ color: 0x5c3b25, roughness: 0.8 });
      const ink = new T.MeshStandardMaterial({ color: 0x1d2620, roughness: 0.35, metalness: 0.1 });
      const cit = new T.MeshStandardMaterial({ color: 0xc9fa74, roughness: 0.3, emissive: 0x86b02c, emissiveIntensity: 0 });
      const cB = C(0x8a5c3b), cC = C(0xf2e4cf), cE = C(0x6b432a), tmp = new T.Color();

      const hg = new T.SphereGeometry(1, 160, 120), hp = hg.attributes.position, hc = new Float32Array(hp.count * 3);
      for (let i = 0; i < hp.count; i++) {
        const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i), f = field(x, y, z);
        hp.setXYZ(i, x * f.r * SX, y * f.r * SY, z * f.r * SZ);
        tmp.copy(cB).lerp(cE, f.ear * 0.5).lerp(cC, f.cream);
        hc[i * 3] = tmp.r; hc[i * 3 + 1] = tmp.g; hc[i * 3 + 2] = tmp.b;
      }
      hg.setAttribute('color', new T.BufferAttribute(hc, 3));
      hg.computeVertexNormals();

      const prof = [[1.4, -2.8], [1.4, -2.3], [1.36, -1.92], [1.25, -1.62], [1.05, -1.37], [0.85, -1.13], [0.74, -0.9], [0.68, -0.68], [0.6, -0.5], [0.001, -0.4]].map(([a, b]) => new T.Vector2(a, b));
      const bg = new T.LatheGeometry(prof, 120), bp = bg.attributes.position, bc = new Float32Array(bp.count * 3);
      for (let i = 0; i < bp.count; i++) {
        const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i), rad = Math.max(0.01, Math.hypot(x, z));
        const w = Math.exp(-((x / (0.4 + 0.1 * -y)) ** 2)) * sm(0, 0.8, z / rad);
        tmp.copy(cB).lerp(cC, sm(0.3, 0.7, w));
        bc[i * 3] = tmp.r; bc[i * 3 + 1] = tmp.g; bc[i * 3 + 2] = tmp.b;
        const t = sm(-1.45, -0.6, y);
        bp.setZ(i, z * (0.8 + 0.42 * t) + 0.08 * t);
      }
      bg.setAttribute('color', new T.BufferAttribute(bc, 3));
      bg.computeVertexNormals();

      const root = new T.Group(); scene.add(root);
      const body = new T.Mesh(bg, furBody); root.add(body);
      const pivot = new T.Group(); pivot.position.set(0, -0.55, 0); root.add(pivot);
      const head = new T.Group(); head.position.set(0, 0.55, 0); pivot.add(head);
      head.add(new T.Mesh(hg, fur));
      const V = a => new T.Vector3(a[0], a[1], a[2]);
      const S = (rad, m, p, s, seg) => { seg = seg || 32; const me = new T.Mesh(new T.SphereGeometry(rad, seg, Math.round(seg * 0.75)), m); me.position.set(p[0], p[1], p[2]); if (s) me.scale.set(s[0], s[1], s[2]); return me; };
      const face = (o, p) => { o.position.set(p[0], p[1], p[2]); o.lookAt(V(p).multiplyScalar(2)); return o; };

      const eyes = [-1, 1].map(s => {
        const g = face(new T.Group(), surf(s * 0.33, 0.14, 0.985));
        const ball = S(0.085, gloss, [0, 0, 0], [1, 1.16, 0.62]);
        const h1 = S(0.026, white, [0.026, 0.042, 0.046], null, 16), h2 = S(0.011, white, [-0.024, -0.03, 0.05], null, 12);
        const arc = new T.Mesh(new T.TorusGeometry(0.066, 0.019, 10, 28, Math.PI), gloss);
        arc.position.set(0, -0.02, 0.03); arc.visible = false;
        g.add(ball, h1, h2, arc); head.add(g);
        return { g, ball, h1, h2, arc, base: g.position.clone() };
      });
      const nose = face(new T.Group(), surf(0, -0.17, 1));
      nose.add(S(0.12, gloss, [0, 0, 0.005], [1.38, 0.82, 0.78]), S(0.022, white, [-0.035, 0.035, 0.085], [1.5, 0.8, 0.6], 12));
      head.add(nose);
      const curve = pts => new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts.map(([x, y]) => V(surf(x, y, 1.012)))), 48, 0.014, 8, false), gloss);
      const mouth = curve([[-0.13, -0.355], [-0.065, -0.405], [0, -0.37], [0.065, -0.405], [0.13, -0.355]]);
      const smile = curve([[-0.17, -0.34], [-0.09, -0.435], [0, -0.46], [0.09, -0.435], [0.17, -0.34]]);
      smile.visible = false;
      head.add(mouth, smile);
      [-1, 1].forEach(s => [0, 1, 2].forEach(k => head.add(S(0.012, dotM, surf(s * (0.17 + k * 0.055), -0.27 - k * 0.022, 1), null, 10))));

      const cup = new T.Mesh(new T.CapsuleGeometry(0.13, 0.1, 8, 20), ink);
      cup.rotation.z = Math.PI / 2;
      cup.position.copy(V(surf(0.95, -0.02, 1))).add(new T.Vector3(0.04, 0, 0));
      head.add(cup);
      head.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([[1.04, -0.1, 0.36], [1.0, -0.33, 0.62], [0.74, -0.5, 0.9], [0.42, -0.52, 1.02]].map(V)), 40, 0.022, 8, false), ink));
      head.add(S(0.058, cit, [0.4, -0.52, 1.03], [1.25, 1, 1], 20));

      const st = this.st = { yaw: 0, pitch: 0, roll: 0, ty: 0, tp: 0, last: -1e9, t: 0, blink: 0, next: 1.6, b: 0, bv: 0, boopUntil: 0, mood: 'idle', ex: 0, ey: 0 };
      this.setMood();
      if (!still) {
        this.pm = e => {
          const b = this.getBoundingClientRect();
          st.ty = clamp((e.clientX - b.left - b.width / 2) / Math.max(320, window.innerWidth * 0.45), -1, 1) * 0.5;
          st.tp = clamp((e.clientY - b.top - b.height / 2) / Math.max(260, window.innerHeight * 0.45), -1, 1) * 0.28;
          st.last = performance.now();
        };
        window.addEventListener('pointermove', this.pm, { passive: true });
        r.domElement.addEventListener('click', () => this.boop());
      }
      const clock = new T.Clock();
      this.frame = dtIn => {
        const once = this.once; this.once = false;
        if (this.dead && !once) return;
        if (!once) this.raf = requestAnimationFrame(() => this.frame());
        if (!once && !this.vis) { clock.getDelta(); return; }
        const dt = dtIn || Math.min(0.05, clock.getDelta());
        st.t += dt;
        if (st.mood === 'happy' && performance.now() > st.boopUntil) this.setMood();
        const m = st.mood, now = performance.now();
        let ty = st.ty, tp = st.tp, tr = 0;
        if (now - st.last > 4000 && !reduce) { ty = Math.sin(st.t * 0.33) * 0.2; tp = Math.sin(st.t * 0.21) * 0.05; }
        if (m === 'listening') { tr = 0.12; tp += 0.03; }
        if (m === 'thinking') { ty = 0.2 + Math.sin(st.t * 0.6) * 0.04; tp = -0.2; tr = -0.05; }
        const k = 1 - Math.pow(0.002, dt), f = reduce ? 0.5 : 1;
        st.yaw = lerp(st.yaw, ty * f, k); st.pitch = lerp(st.pitch, tp * f, k); st.roll = lerp(st.roll, tr, k);
        st.bv += (-st.b * 60 - st.bv * 9) * dt; st.b += st.bv * dt;
        pivot.rotation.set(st.pitch, st.yaw, st.roll);
        body.rotation.y = st.yaw * 0.25;
        const br = reduce ? 0 : Math.sin(st.t * 1.5) * 0.012;
        root.position.y = br + st.b * 0.08;
        body.scale.set(1 + br * 0.4, 1, 1 + br * 0.4);
        st.ex = lerp(st.ex, m === 'thinking' ? 0.025 : st.ty * 0.04, k);
        st.ey = lerp(st.ey, m === 'thinking' ? 0.03 : -st.tp * 0.03, k);
        st.next -= dt;
        if (st.next <= 0) { st.blink = 0.16; st.next = 2.4 + Math.random() * 3; }
        st.blink = Math.max(0, st.blink - dt);
        const lid = st.blink > 0 ? Math.max(0.1, Math.abs(st.blink - 0.08) / 0.08) : 1, happy = m === 'happy';
        eyes.forEach(e => {
          e.g.position.set(e.base.x + st.ex, e.base.y + st.ey, e.base.z);
          e.ball.visible = !happy; e.arc.visible = happy;
          e.ball.scale.y = 1.16 * lid;
          e.h1.visible = e.h2.visible = !happy && lid > 0.5;
        });
        mouth.visible = !happy; smile.visible = happy;
        cit.emissiveIntensity = lerp(cit.emissiveIntensity, m === 'listening' ? 0.8 : 0, k);
        r.render(scene, cam);
      };
      const fit = () => {
        if (this.gone) return;
        const w = Math.max(1, this.clientWidth), h = Math.max(1, this.clientHeight);
        r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
        this.once = true; this.frame(0.016);
      };
      this.vis = true;
      if ('IntersectionObserver' in window) new IntersectionObserver(es => { this.vis = es[0].isIntersecting; }).observe(this);
      fit();
      if (still) {
        const img = new Image();
        img.alt = '';
        img.src = r.domElement.toDataURL('image/png');
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
        this.appendChild(img);
        r.domElement.remove(); r.dispose(); if (r.forceContextLoss) r.forceContextLoss();
        this.gone = true; this.dead = true;
        return;
      }
      new ResizeObserver(fit).observe(this);
      this.loop();
    }
    loop() { cancelAnimationFrame(this.raf); if (this.frame) this.raf = requestAnimationFrame(() => this.frame()); }
  }
  customElements.define('otto-head', Otto);
})();
