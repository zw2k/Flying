import * as THREE from "three";
import { clamp, damp, easeInOutCubic, makeCanvasTexture, mulberry32, smoothstep, signedAngle, TAU } from "./utils.js";

const UP = new THREE.Vector3(0, 1, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);
const BOOST_IN_DURATION = 1.0;
const BOOST_OUT_DURATION = 1.9;
const BOOST_LUNGE = 0.62;
const ROLL_ENTRY_DURATION = 0.85;
const ROLL_EXIT_DURATION = BOOST_OUT_DURATION;
const MORPH_DURATION = 0.82;

function paperTexture() {
  return makeCanvasTexture(512, (ctx, s) => {
    const rng = mulberry32(6281);
    ctx.fillStyle = "#fbfcfc";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 8000; i++) {
      const x = rng() * s;
      const y = rng() * s;
      const a = rng() * 0.055;
      ctx.fillStyle = rng() > 0.45 ? `rgba(110,124,136,${a})` : `rgba(255,255,255,${a})`;
      ctx.fillRect(x, y, 1 + rng() * 2, 0.5 + rng() * 1.2);
    }
    const gradient = ctx.createLinearGradient(0, 0, s, s);
    gradient.addColorStop(0, "rgba(206,220,232,0.10)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0)");
    gradient.addColorStop(1, "rgba(146,164,180,0.08)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, s, s);
  });
}

function triangleGeometry(tris) {
  const positions = [];
  const uvs = [];
  for (const t of tris) {
    const points = Array.isArray(t) ? t : t.points;
    for (const v of points) {
      positions.push(v[0], v[1], v[2]);
      uvs.push(v[0] * 0.36 + 0.5, v[2] * 0.3 + 0.5);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function paintGeometry(geo, color) {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const f = 0.94 + ((i % 3) / 3) * 0.06;
    colors[i * 3] = color.r * f;
    colors[i * 3 + 1] = color.g * f;
    colors[i * 3 + 2] = color.b * f;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Darken the inside of the V toward the bottom crease so the groove reads. */
function paintGroove(geo, color, halfWidth) {
  const position = geo.attributes.position;
  const count = position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, Math.abs(position.getX(i)) / halfWidth);
    const shade = 0.34 + 0.66 * t;
    const f = 0.94 + ((i % 3) / 3) * 0.06;
    colors[i * 3] = color.r * shade * f;
    colors[i * 3 + 1] = color.g * shade * f;
    colors[i * 3 + 2] = color.b * shade * f;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Keep top-surface triangles facing upward, regardless of input winding. */
function faceUp(points) {
  const [a, b, c] = points;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const ny = uz * vx - ux * vz;
  return ny >= 0 ? points : [a, c, b];
}

/** Keep side-surface triangles facing outward on the requested X side. */
function faceOutward(points, sign) {
  const [a, b, c] = points;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  return nx * sign >= 0 ? points : [a, c, b];
}

function createCreaseLines(segments, material) {
  const positions = [];
  for (const [a, b] of segments) positions.push(...a, ...b);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geo, material);
}

class RibbonTrail {
  constructor(scene, color = 0xffe6b5, width = 0.06, max = 30) {
    this.scene = scene;
    this.max = max;
    this.width = width;
    this.points = [];
    this.geometry = new THREE.BufferGeometry();
    const count = max * 2;
    this.positions = new Float32Array(count * 3);
    this.alphas = new Float32Array(count);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const indices = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: 0.24 },
      },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha * uOpacity);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this._tmp = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._view = new THREE.Vector3();
  }

  reset() {
    this.points.length = 0;
    this.geometry.setDrawRange(0, 0);
  }

  push(point) {
    if (this.points.length === 0) {
      this.points.push(point.clone());
      return;
    }
    const last = this.points[0];
    if (last.distanceToSquared(point) > 0.09) {
      this.points.unshift(point.clone());
      if (this.points.length > this.max) this.points.pop();
    } else {
      // Keep the tip glued to the wing so the ribbon never detaches.
      last.copy(point);
    }
  }

  update(camera, opacityScale = 1, widthScale = 1) {
    const n = this.points.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const cam = camera.position;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const prev = this.points[Math.max(0, i - 1)];
      const next = this.points[Math.min(n - 1, i + 1)];
      this._dir.subVectors(prev, next);
      if (this._dir.lengthSq() < 1e-6) this._dir.set(0, 0, 1);
      this._view.subVectors(cam, p);
      // Use world up for a stable ribbon plane; crossing with the view
      // degenerates exactly when the camera sits behind the trail.
      this._side.crossVectors(this._dir, camera.up);
      if (this._side.lengthSq() < 1e-6) {
        this._side.crossVectors(this._dir, this._view);
      }
      if (this._side.lengthSq() < 1e-6) {
        this._side.set(1, 0, 0);
      }
      this._side.normalize();
      const taper = 1 - i / (n - 1);
      const w = this.width * (0.18 + taper * 0.82) * widthScale;
      const idx = i * 2;
      this.positions[idx * 3] = p.x - this._side.x * w;
      this.positions[idx * 3 + 1] = p.y - this._side.y * w;
      this.positions[idx * 3 + 2] = p.z - this._side.z * w;
      this.positions[(idx + 1) * 3] = p.x + this._side.x * w;
      this.positions[(idx + 1) * 3 + 1] = p.y + this._side.y * w;
      this.positions[(idx + 1) * 3 + 2] = p.z + this._side.z * w;
      const dirLen = Math.sqrt(this._dir.lengthSq()) || 1;
      const viewLen = Math.sqrt(this._view.lengthSq()) || 1;
      const alignment = Math.abs(
        (this._dir.x * this._view.x + this._dir.y * this._view.y + this._dir.z * this._view.z) /
          (dirLen * viewLen)
      );
      const facingFade = 0.3 + 0.7 * (1 - Math.pow(alignment, 2.5));
      const alpha = Math.pow(1 - i / (n - 1), 1.5) * facingFade;
      this.alphas[idx] = alpha * opacityScale;
      this.alphas[idx + 1] = alpha * opacityScale;
    }
    // Collapse unused vertices onto the last point.
    for (let i = n; i < this.max; i++) {
      const idx = i * 2;
      this.positions[idx * 3] = this.positions[(idx - 2) * 3];
      this.positions[idx * 3 + 1] = this.positions[(idx - 2) * 3 + 1];
      this.positions[idx * 3 + 2] = this.positions[(idx - 2) * 3 + 2];
      this.positions[(idx + 1) * 3] = this.positions[(idx - 1) * 3];
      this.positions[(idx + 1) * 3 + 1] = this.positions[(idx - 1) * 3 + 1];
      this.positions[(idx + 1) * 3 + 2] = this.positions[(idx - 1) * 3 + 2];
      this.alphas[idx] = 0;
      this.alphas[idx + 1] = 0;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }
}

export class PaperPlane {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.group = new THREE.Group();
    this.group.name = "paper-plane";
    this.group.scale.setScalar(1.5);
    this.visual = new THREE.Group();
    this.group.add(this.visual);
    scene.add(this.group);

    this.position = this.group.position;
    this.direction = new THREE.Vector3(0, 0, -1);
    this.yaw = 0;
    this.pitch = 0;
    this.bank = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.speed = 34;
    this.boost = 0;
    this.boostHeld = false;
    this.boostFrom = 0;
    this.boostTarget = 0;
    this.boostElapsed = BOOST_IN_DURATION;
    this.boostDuration = BOOST_IN_DURATION;
    this.speedStress = 0;
    this.barrelRollAngle = 0;
    this.barrelRollFrom = 0;
    this.barrelRollTo = 0;
    this.barrelRollElapsed = 0;
    this.barrelRollDuration = ROLL_ENTRY_DURATION;
    this.barrelRolling = false;
    this.barrelRollPhase = 'idle'; // idle → entry → exit → idle
    this.barrelRollExitQueued = false;
    this.barrelRollNextEntry = 1;
    this.barrelRollEntryDirection = 1;
    this.baseSpeed = 33;
    this.wingFlex = 0;
    this._q = new THREE.Quaternion();
    this._roll = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._target = new THREE.Vector3();
    this._bob = 0;
    this._time = 0;
    this.bumpCooldown = 0;
    this.glow = 0;
    this.modelStyle = 1;
    this.models = [];
    this.paperMaterials = [];
    this._activeModel = -1;
    this.morph = null;

    this.buildModel();

    this.leftTrail = new RibbonTrail(scene, 0xffe7b4, 0.07, 34);
    this.rightTrail = new RibbonTrail(scene, 0xffe7b4, 0.07, 34);
    this.trailTipLeft = new THREE.Vector3();
    this.trailTipRight = new THREE.Vector3();

    // Paper dust that swirls off the wingtips.
    const dustCount = 64;
    const positions = new Float32Array(dustCount * 3);
    const seeds = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 0.4;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 0.4;
      positions[i * 3 + 2] = Math.random() * 5;
      seeds[i] = Math.random();
    }
    this.dustGeometry = new THREE.BufferGeometry();
    this.dustGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.dustGeometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    this.dustMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uColor: { value: new THREE.Color(0xffd9a0) },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          float t = fract(aSeed + uTime * (0.18 + aSeed * 0.12));
          p.z += t * 1.5;
          p.x += sin(uTime * 2.0 + aSeed * 30.0) * 0.12 * t;
          p.y += cos(uTime * 1.7 + aSeed * 22.0) * 0.09 * t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (2.0 + aSeed * 3.0) * uPixelRatio * (8.0 / -mv.z);
          vAlpha = (1.0 - t) * smoothstep(0.0, 0.1, t);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(d));
          gl_FragColor = vec4(uColor, a * vAlpha * 0.55);
        }
      `,
    });
    this.dust = new THREE.Points(this.dustGeometry, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);

    this.updateOrientation(0);
  }

  buildModel() {
    const tex = paperTexture();
    tex.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.0,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.32,
      vertexColors: true,
    });
    this.material = material;
    this.baseEmissive = material.emissive.clone();
    this.glowEmissive = new THREE.Color(0xffc978);
    this.creaseMaterial = new THREE.LineBasicMaterial({
      color: 0x9aa5ac,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });

    this.models = [
      this.buildClassicModel(material.clone(), this.creaseMaterial.clone()),
      this.buildPhotoModel(material.clone(), this.creaseMaterial.clone()),
      this.buildCraneModel(material.clone(), this.creaseMaterial.clone()),
    ];
    for (const model of this.models) {
      model.group.visible = false;
      this.visual.add(model.group);
    }
    this.paperMaterials = this.models.map((model) => model.material);
    this.setModelStyle(this.modelStyle, true);
  }

  buildClassicModel(material, creaseMaterial) {
    // Classic white paper dart: a high centre ridge, broad swept wings with
    // a notched trailing edge, and a deep keel below.
    const nose = [0, 0.3, -1.98];
    const ridge = [0, 0.58, 0.46];
    const tail = [0, 0.28, 1.16];
    const leftTip = [-1.82, 0.0, 0.42];
    const rightTip = [1.82, 0.0, 0.42];
    const leftNotch = [-0.52, 0.18, 0.82];
    const rightNotch = [0.52, 0.18, 0.82];
    const keel = [0, -0.64, 0.68];

    const leftGeo = triangleGeometry([
      { points: [nose, leftTip, ridge] },
      { points: [ridge, leftTip, leftNotch] },
      { points: [ridge, leftNotch, tail] },
    ]);
    const rightGeo = triangleGeometry([
      { points: [nose, ridge, rightTip] },
      { points: [ridge, rightNotch, rightTip] },
      { points: [ridge, tail, rightNotch] },
    ]);
    const keelGeo = triangleGeometry([
      { points: [nose, keel, ridge] },
      { points: [ridge, keel, tail] },
    ]);
    paintGeometry(leftGeo, new THREE.Color(0xffffff));
    paintGeometry(rightGeo, new THREE.Color(0xf8fafb));
    paintGeometry(keelGeo, new THREE.Color(0xedf1f3));

    const leftWing = new THREE.Mesh(leftGeo, material);
    const rightWing = new THREE.Mesh(rightGeo, material);
    const keelMesh = new THREE.Mesh(keelGeo, material);
    for (const mesh of [leftWing, rightWing, keelMesh]) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    }

    const creases = createCreaseLines(
      [
        [nose, leftTip],
        [nose, rightTip],
        [leftTip, leftNotch],
        [leftNotch, tail],
        [rightTip, rightNotch],
        [rightNotch, tail],
        [nose, ridge],
        [ridge, tail],
        [ridge, leftTip],
        [ridge, rightTip],
        [ridge, leftNotch],
        [ridge, rightNotch],
        [nose, keel],
        [keel, tail],
      ],
      creaseMaterial
    );

    const group = new THREE.Group();
    group.add(leftWing, rightWing, keelMesh, creases);
    return {
      group,
      leftWing,
      rightWing,
      keel: keelMesh,
      creases,
      material,
      creaseMaterial,
      nose: new THREE.Vector3(...nose),
      trailTipLeft: [-1.82, 0.0, 0.42],
      trailTipRight: [1.82, 0.0, 0.42],
    };
  }

  buildPhotoModel(material, creaseMaterial) {
    // Photographic paper-dart variant: a long pointed nose, broad notched
    // wings, and a deep central V-fold. The valley itself is the narrow body
    // groove; the same panels read as the sharp inverted keel from below.
    const nose = [0, -0.02, -2.14];
    const tail = [0, -0.02, 1.3];
    const leftTip = [-2.02, -0.04, 0.52];
    const rightTip = [2.02, -0.04, 0.52];
    const leftNotch = [-0.62, -0.02, 0.96];
    const rightNotch = [0.62, -0.02, 0.96];
    // The wing roots sit level with the wing, so there is no raised spine.
    const leftBody = [-0.3, -0.02, 0.12];
    const rightBody = [0.3, -0.02, 0.12];
    const leftBodyRear = [-0.34, -0.04, 1.02];
    const rightBodyRear = [0.34, -0.04, 1.02];
    // These three points hold the bottom of the valley. The central crease
    // drops below the wing plane and forms the downward-pointing keel fold.
    // The V is deliberately open and broad enough to read as a groove.
    const keelFront = [0, -0.1, -1.55];
    const keelBottom = [0, -0.66, 0.72];
    const keelRear = [0, -0.1, 1.24];

    // The wing panels stop at the body edges, keeping the valley below open.
    const leftGeo = triangleGeometry([
      { points: faceUp([leftTip, nose, leftBody]) },
      { points: faceUp([leftBodyRear, tail, leftNotch]) },
      { points: faceUp([leftNotch, leftTip, leftBody]) },
      { points: faceUp([leftBody, leftBodyRear, leftNotch]) },
    ]);
    const rightGeo = triangleGeometry([
      { points: faceUp([rightTip, nose, rightBody]) },
      { points: faceUp([rightBodyRear, tail, rightNotch]) },
      { points: faceUp([rightNotch, rightTip, rightBody]) },
      { points: faceUp([rightBody, rightBodyRear, rightNotch]) },
    ]);
    // No raised body cap here: the V walls stay open at the top so the long
    // groove is visible from above, while their outside is the keel.
    const keelGeo = triangleGeometry([
      { points: faceOutward([nose, leftBody, keelFront], -1) },
      { points: faceOutward([leftBody, keelBottom, keelFront], -1) },
      { points: faceOutward([leftBody, leftBodyRear, keelBottom], -1) },
      { points: faceOutward([leftBodyRear, keelRear, keelBottom], -1) },
      { points: faceOutward([leftBodyRear, tail, keelRear], -1) },
      { points: faceOutward([nose, keelFront, rightBody], 1) },
      { points: faceOutward([rightBody, keelFront, keelBottom], 1) },
      { points: faceOutward([rightBody, keelBottom, rightBodyRear], 1) },
      { points: faceOutward([rightBodyRear, keelBottom, keelRear], 1) },
      { points: faceOutward([rightBodyRear, keelRear, tail], 1) },
    ]);
    paintGeometry(leftGeo, new THREE.Color(0xffffff));
    paintGeometry(rightGeo, new THREE.Color(0xf7fafb));
    paintGroove(keelGeo, new THREE.Color(0xffffff), 0.34);

    const leftWing = new THREE.Mesh(leftGeo, material);
    const rightWing = new THREE.Mesh(rightGeo, material);
    const keelMesh = new THREE.Mesh(keelGeo, material);
    for (const mesh of [leftWing, rightWing, keelMesh]) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    }

    const creases = createCreaseLines(
      [
        [nose, leftTip],
        [nose, rightTip],
        [leftTip, leftNotch],
        [leftNotch, tail],
        [rightTip, rightNotch],
        [rightNotch, tail],
        [nose, leftBody],
        [leftBody, leftBodyRear],
        [leftBodyRear, tail],
        [nose, rightBody],
        [rightBody, rightBodyRear],
        [rightBodyRear, tail],
        [leftBody, leftNotch],
        [rightBody, rightNotch],
        [nose, keelFront],
        [keelFront, keelBottom],
        [keelBottom, keelRear],
        [keelRear, tail],
      ],
      creaseMaterial
    );
    creaseMaterial.color.setHex(0x6f7d85);

    const group = new THREE.Group();
    group.add(leftWing, rightWing, keelMesh, creases);
    return {
      group,
      leftWing,
      rightWing,
      keel: keelMesh,
      creases,
      material,
      creaseMaterial,
      nose: new THREE.Vector3(...nose),
      trailTipLeft: [-2.02, -0.04, 0.52],
      trailTipRight: [2.02, -0.04, 0.52],
    };
  }

  buildCraneModel(material, creaseMaterial) {
    // Traditional pale-blue origami crane: a folded body, long pointed wings,
    // a slender neck and head, and a raised fan tail. The silhouette stays
    // readable from the chase camera while the neck leads the flight.
    const beakTip = [0, 0.42, -2.12];
    const headTop = [0, 0.64, -1.62];
    const headLeft = [-0.11, 0.51, -1.6];
    const headRight = [0.11, 0.51, -1.6];
    const neckTop = [0, 0.54, -1.22];
    const neckMidLeft = [-0.08, 0.43, -1.28];
    const neckMidRight = [0.08, 0.43, -1.28];
    const neckBaseTop = [0, 0.36, -0.82];
    const neckBaseLeft = [-0.14, 0.25, -0.88];
    const neckBaseRight = [0.14, 0.25, -0.88];
    const bodyTopFront = [0, 0.4, -0.35];
    const bodyTopMid = [0, 0.42, 0.32];
    const bodyTopRear = [0, 0.34, 0.9];
    const bodyLeftFront = [-0.26, 0.12, -0.55];
    const bodyRightFront = [0.26, 0.12, -0.55];
    const bodyLeftMid = [-0.34, 0.1, 0.25];
    const bodyRightMid = [0.34, 0.1, 0.25];
    const bodyLeftRear = [-0.26, 0.14, 0.86];
    const bodyRightRear = [0.26, 0.14, 0.86];
    const bodyBottomFront = [0, -0.12, -0.65];
    const bodyBottomMid = [0, -0.3, 0.25];
    const bodyBottomRear = [0, -0.12, 0.95];
    const tailBase = [0, 0.3, 1.05];
    const tailRidge = [0, 0.54, 1.38];
    const tailTip = [0, 0.7, 1.72];
    const tailLeft = [-0.55, 0.4, 1.15];
    const tailRight = [0.55, 0.4, 1.15];
    const leftWingRootFront = [-0.24, 0.2, -0.35];
    const leftWingRootRear = [-0.3, 0.22, 0.62];
    const leftWingLead = [-1.1, 0.4, -0.5];
    const leftWingTip = [-2.25, 0.64, 0.32];
    const leftWingTrail = [-1.1, 0.38, 0.7];
    const leftWingRidge = [-0.95, 0.46, 0.08];

    const flip = ([x, y, z]) => [-x, y, z];
    const flipTri = (tri) => tri.map(flip);

    const bodyGeo = triangleGeometry([
      // Folded top shell.
      faceUp([neckBaseTop, bodyLeftFront, bodyTopFront]),
      faceUp([bodyTopFront, bodyLeftFront, bodyLeftMid]),
      faceUp([bodyTopFront, bodyLeftMid, bodyTopMid]),
      faceUp([bodyTopMid, bodyLeftMid, bodyLeftRear]),
      faceUp([bodyTopMid, bodyLeftRear, bodyTopRear]),
      faceUp([bodyTopRear, bodyLeftRear, tailBase]),
      faceUp(flipTri([neckBaseTop, bodyRightFront, bodyTopFront])),
      faceUp(flipTri([bodyTopFront, bodyRightFront, bodyRightMid])),
      faceUp(flipTri([bodyTopFront, bodyRightMid, bodyTopMid])),
      faceUp(flipTri([bodyTopMid, bodyRightMid, bodyRightRear])),
      faceUp(flipTri([bodyTopMid, bodyRightRear, bodyTopRear])),
      faceUp(flipTri([bodyTopRear, bodyRightRear, tailBase])),
      // Folded lower body.
      faceOutward([bodyLeftFront, bodyBottomFront, bodyBottomMid], -1),
      faceOutward([bodyLeftFront, bodyBottomMid, bodyLeftMid], -1),
      faceOutward([bodyLeftMid, bodyBottomMid, bodyBottomRear], -1),
      faceOutward([bodyLeftMid, bodyBottomRear, bodyLeftRear], -1),
      faceOutward([bodyLeftRear, bodyBottomRear, tailBase], -1),
      faceOutward(flipTri([bodyRightFront, bodyBottomFront, bodyBottomMid]), 1),
      faceOutward(flipTri([bodyRightFront, bodyBottomMid, bodyRightMid]), 1),
      faceOutward(flipTri([bodyRightMid, bodyBottomMid, bodyBottomRear]), 1),
      faceOutward(flipTri([bodyRightMid, bodyBottomRear, bodyRightRear]), 1),
      faceOutward(flipTri([bodyRightRear, bodyBottomRear, tailBase]), 1),
      // Neck-to-body shoulders.
      faceOutward([neckBaseLeft, bodyLeftFront, neckBaseTop], -1),
      faceOutward([neckBaseRight, bodyRightFront, neckBaseTop], 1),
      faceOutward([neckBaseLeft, bodyBottomFront, bodyLeftFront], -1),
      faceOutward([neckBaseRight, bodyBottomFront, bodyRightFront], 1),
      // Neck and head panels.
      faceOutward([neckBaseTop, neckBaseLeft, neckTop], -1),
      faceOutward([neckTop, neckBaseLeft, neckMidLeft], -1),
      faceOutward([neckTop, neckMidLeft, headTop], -1),
      faceOutward([headTop, neckMidLeft, headLeft], -1),
      faceOutward(flipTri([neckBaseTop, neckBaseRight, neckTop]), 1),
      faceOutward(flipTri([neckTop, neckBaseRight, neckMidRight]), 1),
      faceOutward(flipTri([neckTop, neckMidRight, headTop]), 1),
      faceOutward(flipTri([headTop, neckMidRight, headRight]), 1),
      // Raised fan tail.
      faceUp([tailBase, tailLeft, tailRidge]),
      faceUp([tailLeft, tailTip, tailRidge]),
      faceUp([tailRidge, tailTip, tailRight]),
      faceUp([tailRidge, tailRight, tailBase]),
    ]);

    const beakGeo = triangleGeometry([
      faceUp([headTop, headLeft, beakTip]),
      faceUp([headTop, beakTip, headRight]),
      faceUp([headLeft, beakTip, headRight]),
    ]);

    const leftWingGeo = triangleGeometry([
      faceUp([leftWingRootFront, leftWingLead, leftWingRidge]),
      faceUp([leftWingLead, leftWingTip, leftWingRidge]),
      faceUp([leftWingTip, leftWingTrail, leftWingRidge]),
      faceUp([leftWingTrail, leftWingRootRear, leftWingRidge]),
      faceUp([leftWingRootFront, leftWingRidge, leftWingRootRear]),
    ]);
    const rightWingGeo = triangleGeometry([
      faceUp(flipTri([leftWingRootFront, leftWingLead, leftWingRidge])),
      faceUp(flipTri([leftWingLead, leftWingTip, leftWingRidge])),
      faceUp(flipTri([leftWingTip, leftWingTrail, leftWingRidge])),
      faceUp(flipTri([leftWingTrail, leftWingRootRear, leftWingRidge])),
      faceUp(flipTri([leftWingRootFront, leftWingRidge, leftWingRootRear])),
    ]);

    // Traditional pale-blue crane paper, with darker blue creases.
    paintGeometry(bodyGeo, new THREE.Color(0x8fc3dc));
    paintGeometry(beakGeo, new THREE.Color(0x8fc3dc));
    paintGeometry(leftWingGeo, new THREE.Color(0x9fd0e4));
    paintGeometry(rightWingGeo, new THREE.Color(0x96c9e0));

    const bodyMesh = new THREE.Mesh(bodyGeo, material);
    const beakMesh = new THREE.Mesh(beakGeo, material);
    const leftWing = new THREE.Mesh(leftWingGeo, material);
    const rightWing = new THREE.Mesh(rightWingGeo, material);
    for (const mesh of [bodyMesh, beakMesh, leftWing, rightWing]) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    }

    const creases = createCreaseLines(
      [
        // Body centre and side folds.
        [neckBaseTop, bodyTopFront],
        [bodyTopFront, bodyTopMid],
        [bodyTopMid, bodyTopRear],
        [bodyTopRear, tailBase],
        [bodyLeftFront, bodyLeftMid],
        [bodyLeftMid, bodyLeftRear],
        [bodyRightFront, bodyRightMid],
        [bodyRightMid, bodyRightRear],
        [bodyLeftFront, bodyTopFront],
        [bodyLeftMid, bodyTopMid],
        [bodyLeftRear, bodyTopRear],
        [bodyRightFront, bodyTopFront],
        [bodyRightMid, bodyTopMid],
        [bodyRightRear, bodyTopRear],
        [bodyBottomFront, bodyBottomMid],
        [bodyBottomMid, bodyBottomRear],
        // Neck, head and beak.
        [neckBaseTop, neckTop],
        [neckTop, headTop],
        [headTop, beakTip],
        [neckBaseLeft, neckMidLeft],
        [neckMidLeft, headLeft],
        [headLeft, beakTip],
        [neckBaseRight, neckMidRight],
        [neckMidRight, headRight],
        [headRight, beakTip],
        [neckBaseLeft, neckBaseTop],
        [neckBaseRight, neckBaseTop],
        [neckBaseLeft, bodyLeftFront],
        [neckBaseRight, bodyRightFront],
        // Tail fan.
        [tailBase, tailLeft],
        [tailLeft, tailTip],
        [tailTip, tailRight],
        [tailRight, tailBase],
        [tailBase, tailRidge],
        [tailRidge, tailTip],
        // Left wing folds.
        [leftWingRootFront, leftWingLead],
        [leftWingLead, leftWingTip],
        [leftWingTip, leftWingTrail],
        [leftWingTrail, leftWingRootRear],
        [leftWingRootFront, leftWingRootRear],
        [leftWingRootFront, leftWingRidge],
        [leftWingLead, leftWingRidge],
        [leftWingTip, leftWingRidge],
        [leftWingTrail, leftWingRidge],
        [leftWingRootRear, leftWingRidge],
        // Right wing folds.
        [flip(leftWingRootFront), flip(leftWingLead)],
        [flip(leftWingLead), flip(leftWingTip)],
        [flip(leftWingTip), flip(leftWingTrail)],
        [flip(leftWingTrail), flip(leftWingRootRear)],
        [flip(leftWingRootFront), flip(leftWingRootRear)],
        [flip(leftWingRootFront), flip(leftWingRidge)],
        [flip(leftWingLead), flip(leftWingRidge)],
        [flip(leftWingTip), flip(leftWingRidge)],
        [flip(leftWingTrail), flip(leftWingRidge)],
        [flip(leftWingRootRear), flip(leftWingRidge)],
      ],
      creaseMaterial
    );
    creaseMaterial.color.setHex(0x4f7f98);

    const group = new THREE.Group();
    group.add(leftWing, rightWing, bodyMesh, beakMesh, creases);
    return {
      group,
      leftWing,
      rightWing,
      keel: bodyMesh,
      creases,
      material,
      creaseMaterial,
      nose: new THREE.Vector3(...beakTip),
      trailTipLeft: leftWingTip,
      trailTipRight: flip(leftWingTip),
    };
  }

  setModelStyle(style, immediate = false) {
    if (!this.models.length) return;
    const index = style === 3 ? 2 : style === 2 ? 1 : 0;

    if (immediate || this._activeModel < 0) {
      if (this.morph) this.finishMorph();
      this.selectModelImmediate(index);
      return;
    }

    if (this.morph) {
      // Holding the same choice lets the current transition finish.
      if (this.morph.to === index) return;
      this.finishMorph();
    }
    if (this._activeModel === index) return;

    const from = this._activeModel;
    this.applyModelRefs(index);
    this._activeModel = index;
    this.modelStyle = index + 1;
    this.resetTrails();
    this.startMorph(from, index);
  }

  applyModelRefs(index) {
    const model = this.models[index];
    this.leftWing = model.leftWing;
    this.rightWing = model.rightWing;
    this.keel = model.keel;
    this.creases = model.creases;
    this.noseLocal = model.nose;
    this.trailLocalLeft = model.trailTipLeft;
    this.trailLocalRight = model.trailTipRight;
  }

  resetTrails() {
    if (this.leftTrail) this.leftTrail.reset();
    if (this.rightTrail) this.rightTrail.reset();
  }

  resetModelTransform(index) {
    const group = this.models[index].group;
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
  }

  setModelAlpha(index, alpha, transparent) {
    const model = this.models[index];
    const material = model.material;
    const wasTransparent = material.transparent;
    material.transparent = transparent;
    material.depthWrite = !transparent;
    material.opacity = alpha;
    if (wasTransparent !== transparent) material.needsUpdate = true;
    if (model.creaseMaterial) {
      model.creaseMaterial.opacity = 0.42 * alpha;
    }
  }

  selectModelImmediate(index) {
    this.applyModelRefs(index);
    this._activeModel = index;
    this.modelStyle = index + 1;
    this.morph = null;
    for (let i = 0; i < this.models.length; i++) {
      this.resetModelTransform(i);
      this.setModelAlpha(i, 1, false);
      this.models[i].group.visible = i === index;
    }
    this.resetTrails();
  }

  startMorph(from, to) {
    this.morph = { elapsed: 0, duration: MORPH_DURATION, from, to };
    for (let i = 0; i < this.models.length; i++) {
      const group = this.models[i].group;
      // Only the outgoing and incoming planes belong in the transition. The
      // third model must stay hidden or it ghosts through the morph.
      group.visible = i === from || i === to;
      this.resetModelTransform(i);
      this.setModelAlpha(i, i === to ? 0 : 1, true);
    }
    const incoming = this.models[to].group;
    incoming.position.y = -0.16;
    incoming.rotation.set(0, -1.35, 0.5);
    incoming.scale.set(0.03, 0.03, 1);
  }

  updateMorph(dt) {
    const morph = this.morph;
    if (!morph) return;
    morph.elapsed = Math.min(morph.elapsed + dt, morph.duration);
    const p = morph.duration > 0 ? morph.elapsed / morph.duration : 1;
    const e = easeInOutCubic(p);
    const leaving = this.models[morph.from].group;
    const arriving = this.models[morph.to].group;

    // The outgoing plane folds into a narrow strip while the incoming one
    // unfolds from the same fold. The crossfade keeps the silhouette readable.
    const leavingScale = 1 - e * 0.97;
    leaving.scale.set(
      leavingScale,
      leavingScale,
      1 + Math.sin(p * Math.PI) * 0.08
    );
    leaving.rotation.set(
      Math.sin(p * Math.PI) * 0.16,
      e * 1.45,
      -e * 0.5 - Math.sin(p * Math.PI) * 0.06
    );
    leaving.position.y = Math.sin(p * Math.PI) * 0.16;

    const arrivingScale = 0.03 + e * 0.97;
    arriving.scale.set(
      arrivingScale,
      arrivingScale,
      1 - Math.sin(p * Math.PI) * 0.08
    );
    arriving.rotation.set(
      -Math.sin(p * Math.PI) * 0.16,
      (1 - e) * -1.45,
      (1 - e) * 0.5 + Math.sin(p * Math.PI) * 0.06
    );
    arriving.position.y = -Math.sin(p * Math.PI) * 0.16;

    this.setModelAlpha(
      morph.from,
      1 - smoothstep(0.05, 0.8, p),
      true
    );
    this.setModelAlpha(
      morph.to,
      smoothstep(0.2, 1, p),
      true
    );

    if (p >= 1) this.finishMorph();
  }

  finishMorph() {
    const morph = this.morph;
    if (!morph) return;
    this.morph = null;
    this.applyModelRefs(morph.to);
    this._activeModel = morph.to;
    this.modelStyle = morph.to + 1;
    for (let i = 0; i < this.models.length; i++) {
      this.resetModelTransform(i);
      this.setModelAlpha(i, 1, false);
      this.models[i].group.visible = i === morph.to;
    }
  }

  resetAt(position, direction, speed = 33) {
    this.position.copy(position);
    this.direction.copy(direction).normalize();
    this.yaw = Math.atan2(this.direction.x, -this.direction.z);
    this.pitch = Math.asin(clamp(this.direction.y, -1, 1));
    this.yawRate = 0;
    this.pitchRate = 0;
    this.bank = 0;
    this.speed = speed;
    this.baseSpeed = speed;
    this.boost = 0;
    this.boostHeld = false;
    this.boostFrom = 0;
    this.boostTarget = 0;
    this.boostElapsed = BOOST_IN_DURATION;
    this.boostDuration = BOOST_IN_DURATION;
    this.speedStress = 0;
    this.barrelRollAngle = 0;
    this.barrelRollFrom = 0;
    this.barrelRollTo = 0;
    this.barrelRollElapsed = 0;
    this.barrelRolling = false;
    this.barrelRollPhase = 'idle';
    this.barrelRollExitQueued = false;
    this.barrelRollNextEntry = 1;
    this.barrelRollEntryDirection = 1;
    this.visual.position.set(0, 0, 0);
    this.visual.rotation.set(0, 0, 0);
    this.resetTrails();
    this.glow = 0;
    for (const material of this.paperMaterials) {
      material.emissive.copy(this.baseEmissive);
      material.emissiveIntensity = 0.32;
    }
    this.updateOrientation(0);
  }

  /** A brief warm flare when the plane threads a hoop. */
  pulseGlow(amount = 1) {
    this.glow = Math.min(1.25, this.glow + amount);
  }

  updateGlow(dt) {
    this.glow = damp(this.glow, 0, 2.2, dt);
    const t = clamp(this.glow, 0, 1);
    for (const material of this.paperMaterials) {
      material.emissive.copy(this.baseEmissive).lerp(this.glowEmissive, t);
      material.emissiveIntensity = 0.32 + t * 0.4;
    }
  }

  updateOrientation(dt) {
    const cp = Math.cos(this.pitch);
    this.direction.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this._m.lookAt(new THREE.Vector3(0, 0, 0), this.direction, UP);
    this._q.setFromRotationMatrix(this._m);
    this._roll.setFromAxisAngle(LOCAL_Z, this.bank);
    this._q.multiply(this._roll);
    this.group.quaternion.slerp(this._q, dt > 0 ? 1 : 0.999);
    this.group.quaternion.copy(this._q);
  }

  updateAutopilot(dt, point, tangent, time) {
    this._time = time;
    const bankTarget = Math.sin(time * 0.55) * 0.18 + tangent.x * 0.08;
    this.bank = damp(this.bank, bankTarget, 1.2, dt);
    this.position.copy(point);
    this.position.y += Math.sin(time * 1.15) * 0.12;
    this.direction.copy(tangent).normalize();
    this.yaw = Math.atan2(this.direction.x, -this.direction.z);
    this.pitch = Math.asin(clamp(this.direction.y, -1, 1));
    this.speed = 21;
    this.updateOrientation(1);
    this.animateVisual(dt, time, 0, 0);
    this.updateTrails(dt, 1);
    this.updateGlow(dt);
  }

  updateFlight(dt, input, time) {
    this._time = time;
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    const boosting = !!input.boost;
    if (boosting !== this.boostHeld) {
      this.startBarrelRoll(boosting ? 1 : -1);
      this.boostHeld = boosting;
      this.boostFrom = this.boost;
      this.boostTarget = boosting ? 1 : 0;
      this.boostElapsed = 0;
      this.boostDuration = boosting ? BOOST_IN_DURATION : BOOST_OUT_DURATION;
    }
    // A long, obvious ease-in-out on the way in, and a slower/longer
    // ease-out on the way back. Value-continuous when the key is re-tapped.
    this.boostElapsed = Math.min(this.boostElapsed + dt, this.boostDuration);
    const boostT = this.boostDuration > 0 ? this.boostElapsed / this.boostDuration : 1;
    this.boost = this.boostFrom + (this.boostTarget - this.boostFrom) * easeInOutCubic(boostT);
    if (boostT >= 1) this.boost = this.boostTarget;

    const targetYawRate = input.x * 1.05;
    const targetPitchRate = input.y * 0.9;
    this.yawRate = damp(this.yawRate, targetYawRate, input.hasInput ? 5.5 : 2.6, dt);
    this.pitchRate = damp(this.pitchRate, targetPitchRate, input.hasInput ? 5.5 : 2.6, dt);

    this.yaw += this.yawRate * dt;
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -0.92, 0.9);
    if (Math.abs(this.pitch) > 0.86) this.pitch = damp(this.pitch, Math.sign(this.pitch) * 0.86, 3, dt);

    // Bank into the turn, then relax.
    this.bank = damp(this.bank, -this.yawRate * 0.62 - this.pitchRate * 0.08, 4.2, dt);
    const cp = Math.cos(this.pitch);
    this.direction.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    const targetSpeed = this.baseSpeed + this.boost * 15 - this.direction.y * 7.5;
    this.speed = damp(this.speed, targetSpeed, boosting ? 5.5 : 2.6, dt);
    this.position.addScaledVector(this.direction, this.speed * dt);

    // A soft floor: the cloud sea lifts you if you fall too far.
    let floorBump = false;
    if (this.position.y < -24) {
      this.position.y = damp(this.position.y, -24, 3, dt);
      this.pitch = damp(this.pitch, 0.34, 3.5, dt);
      floorBump = true;
    }

    this.updateOrientation(1);
    this.animateVisual(dt, time, input.x, boosting);
    this.updateTrails(dt, 1);
    this.updateGlow(dt);
    return floorBump;
  }

  /** One full eased turn around the plane's long axis. */
  startBarrelRoll(direction = 1) {
    if (direction > 0) {
      // A tap only counts once the previous entry + exit rolls have finished.
      if (this.barrelRollPhase !== 'idle') return;
      const entryDirection = this.barrelRollNextEntry;
      this.barrelRollNextEntry = -entryDirection;
      this.barrelRollEntryDirection = entryDirection;
      this.barrelRollPhase = 'entry';
      this.barrelRollExitQueued = false;
      this.beginBarrelRoll(entryDirection);
      return;
    }
    // The first release after an entry queues the exit roll. Any further
    // presses/releases during the sequence are ignored.
    if (this.barrelRollPhase !== 'entry' || this.barrelRollExitQueued) return;
    this.barrelRollExitQueued = true;
    if (!this.barrelRolling) this.beginExitRoll();
  }

  beginExitRoll() {
    this.barrelRollPhase = 'exit';
    this.barrelRollExitQueued = false;
    this.beginBarrelRoll(-this.barrelRollEntryDirection, ROLL_EXIT_DURATION);
  }

  beginBarrelRoll(direction, duration = ROLL_ENTRY_DURATION) {
    this.barrelRollFrom = 0;
    this.barrelRollTo = direction * TAU;
    this.barrelRollAngle = 0;
    this.barrelRollElapsed = 0;
    this.barrelRollDuration = duration;
    this.barrelRolling = true;
  }

  updateBarrelRoll(dt) {
    if (!this.barrelRolling) {
      if (this.barrelRollExitQueued && this.barrelRollPhase === 'entry') {
        this.beginExitRoll();
        return;
      }
      // Safety net for any legacy/resumed state: settle back to level.
      this.barrelRollAngle = Math.abs(this.barrelRollAngle) > 1e-4
        ? damp(this.barrelRollAngle, 0, 8, dt)
        : 0;
      return;
    }
    this.barrelRollElapsed = Math.min(
      this.barrelRollElapsed + dt,
      this.barrelRollDuration
    );
    const t = this.barrelRollElapsed / this.barrelRollDuration;
    const eased = easeInOutCubic(t);
    this.barrelRollAngle = this.barrelRollFrom +
      (this.barrelRollTo - this.barrelRollFrom) * eased;
    if (t >= 1) {
      this.barrelRolling = false;
      this.barrelRollAngle = 0;
      this.barrelRollElapsed = 0;
      if (this.barrelRollPhase === 'entry' && this.barrelRollExitQueued) {
        this.beginExitRoll();
      } else if (this.barrelRollPhase === 'exit') {
        this.barrelRollPhase = 'idle';
      }
    }
  }

  animateVisual(dt, time, steer, boosting) {
    this.updateBarrelRoll(dt);
    const speedStress =
      clamp((this.speed - (this.baseSpeed + 8)) / 7, 0, 1) *
      clamp(this.boost, 0, 1);
    this.speedStress = speedStress;

    const jitterX =
      (Math.sin(time * 83.1) + Math.sin(time * 47.7 + 1.3) * 0.55) *
      0.018 * speedStress;
    const jitterY =
      (Math.sin(time * 71.7 + 0.7) + Math.sin(time * 109.3 + 2.1) * 0.45) *
      0.011 * speedStress;
    const jitterZ = Math.sin(time * 67.3 + 1.9) * 0.009 * speedStress;

    this.visual.position.x = jitterX;
    this.visual.position.y = Math.sin(time * 2.4) * 0.018 + jitterY;
    this.visual.position.z = -this.boost * BOOST_LUNGE + jitterZ;
    this.visual.rotation.x = Math.sin(time * 59.3 + 1.1) * 0.007 * speedStress;
    this.visual.rotation.z =
      Math.sin(time * 1.7) * 0.008 +
      this.barrelRollAngle +
      Math.sin(time * 73.9) * 0.011 * speedStress;
    const flex =
      Math.sin(time * 5.4) * 0.012 +
      steer * 0.02 +
      this.boost * 0.012 +
      Math.sin(time * 61.7 + 0.4) * 0.007 * speedStress;
    this.leftWing.rotation.z = flex;
    this.rightWing.rotation.z = -flex;
    this.keel.rotation.z = 0;
    this.updateMorph(dt);
    this.dustMaterial.uniforms.uTime.value = time;
    this.dustMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
    this.dust.material.opacity = 1;
  }

  updateTrails(dt, emitterStrength = 1) {
    this.group.updateMatrixWorld();
    const stress = this.speedStress;
    const time = this._time;
    const wobble = 0.06 * stress;
    const leftX = Math.sin(time * 49.3 + 0.4) * wobble;
    const leftY = Math.cos(time * 61.7 + 1.1) * wobble * 0.7;
    const leftZ = Math.sin(time * 43.1 + 2.3) * wobble * 0.45;
    const rightX = Math.sin(time * 53.9 + 2.6) * wobble;
    const rightY = Math.cos(time * 67.1 + 0.2) * wobble * 0.7;
    const rightZ = Math.sin(time * 47.7 + 0.8) * wobble * 0.45;

    const activeModel = this.models[this._activeModel];
    const modelMatrix = activeModel ? activeModel.group.matrixWorld : this.visual.matrixWorld;
    this.trailTipLeft
      .set(
        this.trailLocalLeft[0] + leftX,
        this.trailLocalLeft[1] + leftY,
        this.trailLocalLeft[2] + leftZ
      )
      .applyMatrix4(modelMatrix);
    this.trailTipRight
      .set(
        this.trailLocalRight[0] + rightX,
        this.trailLocalRight[1] + rightY,
        this.trailLocalRight[2] + rightZ
      )
      .applyMatrix4(modelMatrix);

    // Slight lag so ribbons leave the wingtips at their own pace.
    this.leftTrail.push(this.trailTipLeft);
    this.rightTrail.push(this.trailTipRight);
    const flutter = 1 + Math.sin(time * 23.7) * 0.07 * stress;
    const opacity =
      (0.55 + this.boost * 0.5) *
      emitterStrength *
      (1 + Math.sin(time * 19.1 + 1.1) * 0.08 * stress);
    const widthScale = (1 + this.boost * 0.65) * flutter;
    this.leftTrail.update(this.camera, opacity, widthScale);
    this.rightTrail.update(this.camera, opacity, widthScale);
  }

  get nose() {
    return this._target.copy(this.noseLocal).applyMatrix4(this.group.matrixWorld);
  }

  /**
   * Pure-pursuit steering toward a point, returned as synthetic input so the
   * normal flight model still drives banking, trails and dust naturally.
   * Used by auto-flight to thread the plane through every hoop.
   */
  autoInput(point, bankBias = 0) {
    const dx = point.x - this.position.x;
    const dy = point.y - this.position.y;
    const dz = point.z - this.position.z;
    const flat = Math.sqrt(dx * dx + dz * dz);
    if (flat < 0.001) return { x: 0, y: 0, boost: false, hasInput: true };

    const desiredYaw = Math.atan2(dx, -dz);
    const desiredPitch = clamp(Math.atan2(dy, flat), -0.6, 0.6);
    const yawError = signedAngle(this.yaw, desiredYaw);
    const pitchError = desiredPitch - this.pitch;

    // Proportional steering with rate damping settles onto the hoop without
    // swinging past it. updateFlight turns these into yaw/pitch rates. The
    // small bank bias lets the autopilot lean into an occasional flourish.
    const yaw = clamp(yawError * 2.3 - this.yawRate * 0.22 + bankBias, -1, 1);
    const pitch = clamp(pitchError * 2.0 - this.pitchRate * 0.25, -0.95, 0.95);

    return { x: yaw, y: pitch, boost: false, hasInput: true };
  }

  /**
   * A gentle tailwind toward the next ring, used only while the pilot is
   * resting. It keeps the journey unhurried and forgiving.
   */
  applyWind(dt, point, strength = 1) {
    const dx = point.x - this.position.x;
    const dy = point.y - this.position.y;
    const dz = point.z - this.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 12 || len > 900) return;
    const desiredYaw = Math.atan2(dx, -dz);
    const desiredPitch = clamp(Math.asin(clamp(dy / len, -1, 1)), -0.5, 0.5);
    const dyaw = signedAngle(this.yaw, desiredYaw);
    const dpitch = desiredPitch - this.pitch;
    const closeness = clamp((len - 25) / 260, 0, 1);
    const k = strength * closeness;
    this.yaw += dyaw * Math.min(k * dt * 1.1, 0.12);
    this.pitch = clamp(this.pitch + dpitch * Math.min(k * dt * 1.1, 0.09), -0.9, 0.9);
    this.bank = damp(this.bank, -dyaw * 0.5, 2.6, dt);
    const cp = Math.cos(this.pitch);
    this.direction.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.updateOrientation(1);
  }

  /** Nudge the plane away from a collision. */
  bump(normal, amount = 2.5) {
    if (this.bumpCooldown > 0) return false;
    this.bumpCooldown = 0.75;
    this.position.addScaledVector(normal, amount);
    this.pitch = clamp(this.pitch + 0.35, -0.7, 0.9);
    this.yawRate = 0;
    this.speed *= 0.78;
    this.bank += (Math.random() - 0.5) * 0.5;
    this.leftTrail.reset();
    this.rightTrail.reset();
    return true;
  }
}
