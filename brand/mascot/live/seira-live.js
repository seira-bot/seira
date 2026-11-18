// seira-live.js: the live 3D mascot of seira.bot (mascot D, "companion bot").
// ES module with no imports. Pass the THREE namespace in:
//   import * as THREE from 'three';
//   import { mountSeira } from './seira-live.js';
//   const seira = mountSeira(THREE, document.querySelector('#stage'));
// The head turns to the pointer, the screen eyes look and blink, the body floats,
// and a click makes Seira smile. All face sizes use Fibonacci numbers of one unit.

const F = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

// Head geometry (head shell radius = 1).
const VISOR_R = 1.015;
const FRINGE_Y = 0.45;          // fringe line, world y
const VISOR_TOP_Y = 0.47;       // screen starts under the fringe
const VISOR_BOTTOM_Y = -0.63;
const VISOR_SPAN = 2.5;         // radians around the head
const HAIR_R = 1.1;
const HAIR_C = [0, 0.28, -0.03];
const HAIR_SX = 1.12;           // hair is wider than tall

// Face canvas. One face unit U = 6 px; every face size is F(n) * U.
const U = 6;
const FW = 1024;
const TH0 = Math.acos(VISOR_TOP_Y / VISOR_R);
const TH1 = Math.acos(VISOR_BOTTOM_Y / VISOR_R);
const FH = Math.round(FW * (TH1 - TH0) / VISOR_SPAN);
const FRINGE_PX = Math.round((Math.acos(FRINGE_Y / VISOR_R) - TH0) / (TH1 - TH0) * FH);

const LED = '#FF2A57';
const LED_GLOW = 'rgba(255, 42, 87, 0.85)';

const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));

export function drawFace(ctx, s) {
  const c = ctx;
  c.save();
  c.clearRect(0, 0, FW, FH);

  // Screen: flat top under the fringe, round bottom corners.
  const g = c.createLinearGradient(0, 0, 0, FH);
  g.addColorStop(0, '#0C0F14');
  g.addColorStop(1, '#040507');
  c.fillStyle = g;
  c.beginPath();
  c.roundRect(0, -F[11], FW, FH + F[11], [0, 0, F[12], F[12]]);
  c.fill();

  const ew = F[8] * U;            // 21
  const eh = F[9] * U;            // 34
  const half = F[8] * U;          // inner half gap 21
  const top = FRINGE_PX + F[7] * U + s.ey;   // 13 below the fringe
  const cx = [FW / 2 - half - ew / 2 + s.ex, FW / 2 + half + ew / 2 + s.ex];

  c.shadowColor = LED_GLOW;
  c.shadowBlur = F[6] * U;
  c.fillStyle = LED;
  c.strokeStyle = LED;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  const happy = s.mood === 'happy';
  for (let i = 0; i < 2; i++) {
    const x = cx[i];
    const out = i === 0 ? -1 : 1;          // outer side
    if (happy) {
      // Eyes as upward arcs.
      c.lineWidth = F[5] * U;
      c.beginPath();
      c.arc(x, top + eh / 2 + F[5] * U, ew / 2 + F[3] * U, Math.PI * 1.08, Math.PI * 1.92);
      c.stroke();
    } else {
      const h = Math.max(F[4] * U, eh * (1 - 0.92 * s.blink));
      const y = top + (eh - h) / 2;
      const r = Math.min(ew / 2, h / 2);
      c.beginPath();
      c.roundRect(x - ew / 2, y, ew, h, r);
      c.fill();
      if (s.blink < 0.5) {
        // White highlight on the inner upper side.
        c.save();
        c.shadowBlur = 0;
        c.fillStyle = '#FFFFFF';
        c.beginPath();
        c.arc(x - out * (ew / 2 - F[5] * U - F[6] * U / 2), y + F[5] * U + F[6] * U / 2, F[6] * U / 2, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
    }
    // Lash flick at the outer upper corner.
    c.lineWidth = F[4] * U;
    const lx = x + out * ew * 0.36;
    const ly = (happy ? top + F[6] * U : top + (eh - Math.max(F[4] * U, eh * (1 - 0.92 * s.blink))) / 2) + F[4] * U;
    c.beginPath();
    c.moveTo(lx, ly);
    c.quadraticCurveTo(x + out * (ew / 2 + F[4] * U), ly - F[4] * U, x + out * (ew / 2 + F[6] * U), ly - F[6] * U);
    c.stroke();
  }

  // Mouth.
  const mx = FW / 2 + s.ex * 0.6;
  const my = top + eh + F[5] * U + s.ey * 0.4;
  if (happy) {
    c.beginPath();
    c.arc(mx, my, F[6] * U, 0, Math.PI);
    c.closePath();
    c.fill();
  } else {
    c.lineWidth = F[4] * U;
    c.beginPath();
    c.arc(mx, my - F[5] * U, F[6] * U, Math.PI * 0.22, Math.PI * 0.78);
    c.stroke();
  }
  c.restore();
}

export function mountSeira(THREE, el, opts = {}) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const still = opts.still ?? reduce;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.0;
  renderer.setClearColor(0x000000, 0);
  const cvs = renderer.domElement;
  cvs.style.display = 'block';
  cvs.style.width = '100%';
  cvs.style.height = '100%';
  cvs.setAttribute('aria-hidden', 'true');
  el.appendChild(cvs);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0.1, 8.6);
  camera.lookAt(0, -0.3, 0);

  // Studio light: a small room of soft boxes, baked into an environment map.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(12, 8, 12), new THREE.MeshBasicMaterial({ color: 0x8d939a, side: THREE.BackSide })));
  const box = (w, h, x, y, z, rx, ry, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(i, i, i) }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    room.add(m);
  };
  box(6, 3, 0, 3.9, 0.5, Math.PI / 2, 0, 5);
  box(3, 4, -5.9, 0.5, 1.5, 0, Math.PI / 2, 3);
  box(3, 4, 5.9, 0.5, 1.5, 0, -Math.PI / 2, 1.5);
  box(5, 2, 0, 0.3, 5.9, 0, Math.PI, 1.2);
  const envRT = pmrem.fromScene(room, 0.03);
  scene.environment = envRT.texture;
  room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(-2.5, 4, 5);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb4bac2, 0.5));

  const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xeceef1, roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.35 });
  const hairMat = new THREE.MeshPhysicalMaterial({ color: 0xe9ecef, roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.28, side: THREE.DoubleSide });
  const grooveMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.7 });

  const bot = new THREE.Group();
  const head = new THREE.Group();
  bot.add(head);
  scene.add(bot);
  const SEG = 96;

  // Head shell.
  head.add(new THREE.Mesh(new THREE.SphereGeometry(1, SEG, SEG / 2), shellMat));

  // Hair dome: a cap above the fringe, and a back part that falls to the neck.
  const hair = new THREE.Group();
  hair.position.set(HAIR_C[0], HAIR_C[1], HAIR_C[2]);
  hair.scale.set(HAIR_SX, 1, 1);
  head.add(hair);
  const thF = Math.acos((FRINGE_Y - HAIR_C[1]) / HAIR_R);
  const thB = Math.acos((-0.62 - HAIR_C[1]) / HAIR_R);
  hair.add(new THREE.Mesh(new THREE.SphereGeometry(HAIR_R, SEG, SEG / 2, 0, Math.PI * 2, 0, thF), hairMat));
  const backHalf = Math.PI - 1.2;
  hair.add(new THREE.Mesh(new THREE.SphereGeometry(HAIR_R, SEG, SEG / 2, Math.PI * 1.5 - backHalf, backHalf * 2, thF, thB - thF), hairMat));
  // Underside of the fringe.
  const ringOuter = Math.sqrt(HAIR_R * HAIR_R - (FRINGE_Y - HAIR_C[1]) ** 2);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, ringOuter, SEG, 1), hairMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = FRINGE_Y - HAIR_C[1];
  hair.add(ring);
  // Fringe grooves: four soft lines from the fringe edge up.
  for (const o of [-0.92, -0.36, 0.36, 0.92]) {
    const phi = Math.PI / 2 + o;
    const pts = [];
    for (let j = 0; j <= 12; j++) {
      const th = thF - 0.02 - j * 0.045;
      const rr = HAIR_R + 0.003;
      pts.push(new THREE.Vector3(-rr * Math.cos(phi) * Math.sin(th), rr * Math.cos(th), rr * Math.sin(phi) * Math.sin(th)));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0075, 6), grooveMat);
    hair.add(tube);
  }

  // Side hair panels.
  const prof = new THREE.Shape();
  prof.moveTo(-0.6, 0.4);
  prof.lineTo(0.56, 0.4);
  prof.lineTo(0.52, -1.25);
  prof.quadraticCurveTo(0.5, -1.62, 0.26, -1.72);
  prof.quadraticCurveTo(-0.12, -1.15, -0.6, -0.35);
  prof.lineTo(-0.6, 0.4);
  const pg = new THREE.ExtrudeGeometry(prof, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 8, curveSegments: 32 });
  pg.translate(0, 0, -0.08);
  pg.rotateY(-Math.PI / 2);
  pg.computeVertexNormals();
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(pg, hairMat);
    p.position.x = side * 1.04;
    p.rotation.z = side * 0.05;
    head.add(p);
  }

  // Screen visor with the face drawn on a canvas.
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = FW;
  faceCanvas.height = FH;
  const fctx = faceCanvas.getContext('2d');
  const faceTex = new THREE.CanvasTexture(faceCanvas);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const visorMat = new THREE.MeshPhysicalMaterial({
    map: faceTex, emissiveMap: faceTex, emissive: 0xffffff, emissiveIntensity: 1.2,
    roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true,
  });
  head.add(new THREE.Mesh(new THREE.SphereGeometry(VISOR_R, SEG, SEG / 2, Math.PI / 2 - VISOR_SPAN / 2, VISOR_SPAN, TH0, TH1 - TH0), visorMat));

  // Soft shadow on the floor.
  const sc = document.createElement('canvas');
  sc.width = sc.height = 128;
  const sg = sc.getContext('2d');
  const rg = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, 'rgba(16, 20, 26, 0.5)');
  rg.addColorStop(1, 'rgba(16, 20, 26, 0)');
  sg.fillStyle = rg;
  sg.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(sc);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.0), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -2.15;
  scene.add(shadow);

  // State.
  const s = { ex: 0, ey: 0, blink: 0, mood: 'calm' };
  let sx = 0, sy = 0;
  let px = null, py = 0, lastMove = -1e9;
  let nextBlink = 1200, blinkAt = -1e9, moodUntil = 0, hopAt = -1e9;
  let lastKey = '';
  let visible = true, raf = 0, prev = performance.now();

  const onMove = (e) => { px = e.clientX; py = e.clientY; lastMove = performance.now(); };
  const smile = () => {
    const now = performance.now();
    s.mood = 'happy';
    moodUntil = now + F[17];      // 1597 ms
    hopAt = now;
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  el.addEventListener('click', smile);

  const resize = () => {
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 34 : 28;
    camera.updateProjectionMatrix();
    draw(performance.now(), true);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(el);
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((es) => { visible = es[0].isIntersecting; })
    : null;
  if (io) io.observe(el);

  function draw(now, force) {
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    const t = now / 1000;
    const r = el.getBoundingClientRect();
    let tx = 0, ty = 0;
    if (px !== null && now - lastMove < 3000) {
      tx = clamp((px - (r.left + r.width / 2)) / (r.width * 0.6));
      ty = clamp((py - (r.top + r.height * 0.42)) / (r.height * 0.6));
    } else if (!still) {
      tx = Math.sin(t * 0.5) * 0.35 + Math.sin(t * 0.21) * 0.15;
      ty = Math.sin(t * 0.33) * 0.18;
    }
    const k = still ? 1 : 1 - Math.pow(0.002, dt);
    sx += (tx - sx) * k;
    sy += (ty - sy) * k;

    // Blink and mood.
    if (!still && now > nextBlink) {
      blinkAt = now;
      nextBlink = now + 2584 + Math.random() * 2584;
      if (Math.random() < 0.2) nextBlink = now + F[13] + F[12];    // double blink
    }
    const bp = (now - blinkAt) / F[12];                           // 144 ms
    s.blink = bp > 0 && bp < 1 ? Math.sin(bp * Math.PI) : 0;
    if (s.mood === 'happy' && now > moodUntil) s.mood = 'calm';
    s.ex = Math.round(sx * F[5] * U * 2);
    s.ey = Math.round(sy * F[4] * U * 2);

    // Head and body.
    const hp = (now - hopAt) / F[15];                             // 610 ms
    const hop = hp > 0 && hp < 1 ? Math.sin(hp * Math.PI) * 0.18 : 0;
    head.rotation.y = sx * 0.55;
    head.rotation.x = sy * 0.3;
    head.rotation.z = -sx * 0.06 + (still ? 0 : Math.sin(t * 0.8) * 0.025);
    bot.position.y = (still ? 0 : Math.sin(t * 1.2) * 0.07) + hop;
    const lift = bot.position.y;
    shadow.scale.setScalar(1 - lift * 0.9);
    shadow.material.opacity = 1 - lift * 2.2;

    const fk = `${s.ex},${s.ey},${s.blink.toFixed(2)},${s.mood}`;
    if (force || fk !== lastKey) {
      lastKey = fk;
      drawFace(fctx, s);
      faceTex.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!visible || document.hidden) { prev = now; return; }
    draw(now, false);
  }
  resize();
  if (still) {
    draw(performance.now(), true);
    window.addEventListener('pointermove', () => requestAnimationFrame((n) => draw(n, false)), { passive: true });
  } else {
    raf = requestAnimationFrame(loop);
  }

  return {
    smile,
    canvas: cvs,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      el.removeEventListener('click', smile);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      envRT.dispose();
      renderer.dispose();
      cvs.remove();
    },
  };
}
