import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  TAU,
  clamp,
  damp,
  fbm2,
  makeCanvasTexture,
  mulberry32,
  smoothstep,
  createCloudTexture,
  createGlowTexture,
  createSoftDiscTexture,
} from "./utils.js";

export const SUN_DIRECTION = new THREE.Vector3(0.38, 0.16, -0.91).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xffffff);

const COURSE_ORIGIN = { x: 30 * Math.sin(1.3), y: 14 * Math.sin(0.3) + 6 * Math.sin(1.7) };

export function courseRaw(d, out = new THREE.Vector3()) {
  return out.set(
    88 * Math.sin(d * 0.0032) + 30 * Math.sin(d * 0.0081 + 1.3) + 8 * Math.sin(d * 0.021 + 0.5),
    42 + 14 * Math.sin(d * 0.0052 + 0.3) + 6 * Math.sin(d * 0.014 + 1.7),
    -d
  );
}

export function coursePoint(d, out = new THREE.Vector3()) {
  courseRaw(d, out);
  out.x -= COURSE_ORIGIN.x;
  out.y -= COURSE_ORIGIN.y;
  return out;
}

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
export function courseTangent(d, out = new THREE.Vector3()) {
  coursePoint(d - 1.5, _p0);
  coursePoint(d + 1.5, _p1);
  return out.subVectors(_p1, _p0).normalize();
}

export function courseRight(d, out = new THREE.Vector3()) {
  courseTangent(d, out);
  return out.set(-out.z, 0, out.x).normalize();
}

/* ————————————————————————————————————————————————
   Sky & atmosphere
   ———————————————————————————————————————————————— */

export class SkyDome {
  constructor(scene) {
    const geometry = new THREE.SphereGeometry(2800, 48, 32);
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uSunDirection: { value: SUN_DIRECTION.clone() },
        uTop: { value: new THREE.Color(0x39447e) },
        uUpper: { value: new THREE.Color(0x815a91) },
        uHorizon: { value: new THREE.Color(0xf2956c) },
        uBottom: { value: new THREE.Color(0x3b3057) },
        uSun: { value: new THREE.Color(0xffcf8a) },
        uMoonDirection: { value: SUN_DIRECTION.clone().negate() },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDirection;
        uniform vec3 uTop;
        uniform vec3 uUpper;
        uniform vec3 uHorizon;
        uniform vec3 uBottom;
        uniform vec3 uSun;
        uniform vec3 uMoonDirection;
        uniform float uNight;
        varying vec3 vDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) {
            v += noise(p) * a;
            p = p * 2.03 + 11.7;
            a *= 0.5;
          }
          return v;
        }
        float starHash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float starField(vec3 dir, float time) {
          vec3 p = dir * 140.0;
          vec3 id = floor(p);
          vec3 f = fract(p) - 0.5;
          float h = starHash(id);
          float star = smoothstep(0.993, 1.0, h) * (1.0 - smoothstep(0.0, 0.42, length(f)));
          float twinkle = 0.62 + 0.38 * sin(time * (0.8 + h * 2.2) + h * 50.0);
          return star * twinkle;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          float upMix = pow(clamp((h + 0.08) / 0.95, 0.0, 1.0), 0.72);
          vec3 col = mix(uHorizon, uUpper, smoothstep(0.0, 0.42, upMix));
          col = mix(col, uTop, smoothstep(0.36, 1.0, upMix));
          col = mix(uBottom, col, smoothstep(-0.42, -0.015, h));

          // The sun, low and forgiving.
          float sunDot = max(dot(dir, uSunDirection), 0.0);
          float disc = smoothstep(0.99942, 0.99972, sunDot);
          float innerHalo = pow(sunDot, 1150.0) * 0.9;
          float halo = pow(sunDot, 55.0) * 0.24;
          float wideHalo = pow(sunDot, 7.0) * 0.08;

          // Horizontal brushstrokes of high cloud around the sun.
          float bandCoord = atan(dir.z, dir.x) * 1.35;
          float wisps = fbm(vec2(bandCoord * 1.8 + uTime * 0.002, h * 5.5 - uTime * 0.004));
          float wispMask = smoothstep(0.53, 0.8, wisps) * smoothstep(0.04, 0.28, h) * smoothstep(0.72, 0.3, h);
          vec3 wispColor = mix(uHorizon, uSun, 0.44);
          col = mix(col, wispColor, wispMask * 0.19);

          float horizonHaze = exp(-abs(h) * 24.0) * (0.18 + 0.14 * fbm(vec2(bandCoord * 0.8, 1.5)));
          col = mix(col, uSun * 0.8 + uHorizon * 0.45, horizonHaze * 0.4);

          col += uSun * (disc * 3.6 + innerHalo * 1.5 + halo + wideHalo);
          col += mix(uSun, vec3(1.0, 0.55, 0.36), 0.5) * pow(sunDot, 220.0) * 0.16;

          // A pale moon and a quiet field of stars take over after sunset.
          float moonDot = max(dot(dir, uMoonDirection), 0.0);
          float moonDisc = smoothstep(0.99958, 0.99984, moonDot);
          float moonHalo = pow(moonDot, 160.0) * 0.12;
          float moonWide = pow(moonDot, 10.0) * 0.02;
          col += vec3(0.76, 0.84, 1.0) *
            (moonDisc * 2.0 + moonHalo + moonWide) * uNight;

          float star = starField(dir, uTime) *
            smoothstep(-0.02, 0.18, h) * uNight;
          vec3 starColor = mix(
            vec3(0.72, 0.82, 1.0),
            vec3(1.0, 0.9, 0.72),
            fract(starHash(floor(dir * 140.0)) * 13.0)
          );
          col += starColor * star * 0.9;

          // A gentle paper-like dither keeps the broad gradient from banding.
          float dither = (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
          gl_FragColor = vec4(col + dither, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }

  update(dt, time, camera) {
    this.mesh.position.copy(camera.position);
    this.material.uniforms.uTime.value = time;
  }
}

/* ————————————————————————————————————————————————
   Clouds
   ———————————————————————————————————————————————— */

export class CloudField {
  constructor(scene, count = 620) {
    this.count = count;
    const rng = mulberry32(94017);
    const base = (this.base = new Float32Array(count * 3));
    const attrs = {
      offset: new Float32Array(count * 3),
      scale: new Float32Array(count * 2),
      tint: new Float32Array(count * 3),
      alpha: new Float32Array(count),
      phase: new Float32Array(count),
      rot: new Float32Array(count),
    };

    const warm = [
      new THREE.Color(0xffebc9),
      new THREE.Color(0xffd9bd),
      new THREE.Color(0xf9c7b0),
      new THREE.Color(0xe9d6d6),
      new THREE.Color(0xffe6b0),
    ];

    for (let i = 0; i < count; i++) {
      const band = rng();
      let x = (rng() - 0.5) * 1800;
      let z = (rng() - 0.5) * 1800;
      let y;
      let s;
      let alpha;
      if (band < 0.42) {
        y = -55 + rng() * 95;
        if (Math.abs(x) + Math.abs(z) < 260) y -= 18;
        s = 60 + rng() * 170;
        alpha = 0.12 + rng() * 0.16;
      } else if (band < 0.75) {
        x *= 0.72;
        y = 22 + rng() * 96;
        s = 26 + rng() * 82;
        alpha = 0.075 + rng() * 0.16;
      } else {
        y = 110 + rng() * 200;
        s = 24 + rng() * 92;
        alpha = 0.045 + rng() * 0.13;
      }
      base[i * 3] = x;
      base[i * 3 + 1] = y;
      base[i * 3 + 2] = z;
      attrs.offset[i * 3] = x;
      attrs.offset[i * 3 + 1] = y;
      attrs.offset[i * 3 + 2] = z;
      attrs.scale[i * 2] = s * (1.25 + rng() * 0.8);
      attrs.scale[i * 2 + 1] = s * (0.55 + rng() * 0.42);
      attrs.alpha[i] = alpha;
      attrs.phase[i] = rng() * TAU;
      attrs.rot[i] = (rng() - 0.5) * 0.2;
      const c = warm[Math.floor(rng() * warm.length)].clone();
      c.offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08);
      attrs.tint[i * 3] = c.r;
      attrs.tint[i * 3 + 1] = c.g;
      attrs.tint[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute("aOffset", new THREE.InstancedBufferAttribute(attrs.offset, 3));
    geometry.setAttribute("aScale", new THREE.InstancedBufferAttribute(attrs.scale, 2));
    geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(attrs.tint, 3));
    geometry.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(attrs.alpha, 1));
    geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(attrs.phase, 1));
    geometry.setAttribute("aRot", new THREE.InstancedBufferAttribute(attrs.rot, 1));
    geometry.instanceCount = count;
    this.geometry = geometry;

    const texture = createCloudTexture();
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      uniforms: {
        uMap: { value: texture },
        uTime: { value: 0 },
        uFogColor: { value: new THREE.Color(0xf2b296) },
        uFogDensity: { value: 0.00078 },
        uSun: { value: new THREE.Color(0xffd3a2) },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec2 aScale;
        attribute vec3 aTint;
        attribute float aAlpha;
        attribute float aPhase;
        attribute float aRot;
        uniform float uTime;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying vec3 vTint;
        varying float vAlpha;
        varying float vHeight;

        void main() {
          vec3 offset = aOffset;
          offset.x += sin(uTime * 0.028 + aPhase) * 5.0;
          offset.y += cos(uTime * 0.021 + aPhase * 1.7) * 2.2;
          vec4 center = viewMatrix * vec4(offset, 1.0);
          vec2 corner = position.xy;
          float c = cos(aRot), s = sin(aRot);
          vec2 rc = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
          center.xy += rc * aScale;
          gl_Position = projectionMatrix * center;
          vUv = position.xy + 0.5;
          vTint = aTint;
          vHeight = position.y + 0.5;
          float dist = length(center.xyz);
          vAlpha = aAlpha * smoothstep(1500.0, 250.0, dist) * exp(-dist * uFogDensity * 0.55);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uFogColor;
        uniform vec3 uSun;
        uniform float uNight;
        varying vec2 vUv;
        varying vec3 vTint;
        varying float vAlpha;
        varying float vHeight;

        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.012) discard;
          vec3 col = vTint * (0.82 + vHeight * 0.42);
          col = mix(col, uSun, smoothstep(0.3, 0.95, vHeight) * 0.22);
          col += uSun * smoothstep(0.6, 1.0, vHeight) * 0.06;
          col = mix(col, vec3(0.22, 0.28, 0.46), uNight * 0.55);
          col *= mix(1.0, 0.72, uNight);
          float edge = smoothstep(0.0, 0.24, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
          float a = tex.a * vAlpha * (0.6 + edge * 0.55);
          gl_FragColor = vec4(mix(col, uFogColor, 0.1), a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.offsetAttr = geometry.getAttribute("aOffset");
  }

  update(dt, time, camera) {
    this.material.uniforms.uTime.value = time;
    const cam = camera.position;
    const offsets = this.offsetAttr.array;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      let x = offsets[ix];
      let y = offsets[ix + 1];
      let z = offsets[ix + 2];
      const dx = x - cam.x;
      const dz = z - cam.z;
      if (dx > 920) x -= 1840;
      else if (dx < -920) x += 1840;
      if (dz > 920) z -= 1840;
      else if (dz < -920) z += 1840;
      if (y - cam.y > 420) y -= 520;
      else if (cam.y - y > 330) y += 520;
      if (x !== offsets[ix] || y !== offsets[ix + 1] || z !== offsets[ix + 2]) {
        offsets[ix] = x;
        offsets[ix + 1] = y;
        offsets[ix + 2] = z;
        changed = true;
      }
    }
    if (changed) this.offsetAttr.needsUpdate = true;
  }
}

export class CloudSea {
  constructor(scene) {
    const geometry = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDirection: { value: SUN_DIRECTION.clone() },
        uFogColor: { value: new THREE.Color(0xe9a488) },
        uDeep: { value: new THREE.Color(0x4a3866) },
        uLit: { value: new THREE.Color(0xffd2a0) },
        uRose: { value: new THREE.Color(0xbf737d) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDirection;
        uniform vec3 uFogColor;
        uniform vec3 uDeep;
        uniform vec3 uLit;
        uniform vec3 uRose;
        varying vec3 vWorld;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.52;
          for (int i = 0; i < 6; i++) {
            v += noise(p) * a;
            p = p * 2.06 + 7.3;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec2 p = vWorld.xz * 0.0034;
          float drift = uTime * 0.0028;
          float n = fbm(p + vec2(drift, -drift * 0.6));
          float fine = fbm(p * 3.4 + vec2(-drift * 1.2, drift)) * 0.36;
          float billow = smoothstep(0.44, 0.76, n + fine);
          float shadow = smoothstep(0.6, 0.2, n + fine);

          vec3 col = mix(uDeep, uRose, smoothstep(0.16, 0.52, n + fine));
          col = mix(col, uLit, smoothstep(0.52, 0.84, n + fine * 0.7));
          col *= 1.0 - shadow * 0.22;
          col = mix(col, uFogColor, smoothstep(0.68, 0.98, billow) * 0.2);

          vec3 toSun = normalize(uSunDirection);
          vec3 viewDir = normalize(vWorld - cameraPosition);
          float sunSheen = pow(max(dot(reflect(viewDir, vec3(0.0, 1.0, 0.0)), toSun), 0.0), 7.0);
          col += uLit * sunSheen * 0.2;

          float dist = distance(vWorld, cameraPosition);
          float fog = 1.0 - exp(-dist * dist * 0.00000042);
          col = mix(col, uFogColor, clamp(fog, 0.0, 0.93));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = -72;
    this.mesh.renderOrder = 0;
    scene.add(this.mesh);
  }

  update(dt, time, camera) {
    this.material.uniforms.uTime.value = time;
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }
}

/* ————————————————————————————————————————————————
   Waterfalls
   ———————————————————————————————————————————————— */

const waterfallVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const waterfallFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uNight;
  varying vec2 vUv;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += noise(p) * a; p *= 2.04; a *= 0.5; }
    return v;
  }

  void main() {
    float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
    float top = smoothstep(0.0, 0.04, vUv.y);
    float down = smoothstep(1.0, 0.65, vUv.y);
    float flow = fbm(vec2(vUv.x * 9.0, vUv.y * 4.5 - uTime * 1.15));
    float threads = smoothstep(0.44, 0.8, fbm(vec2(vUv.x * 18.0, vUv.y * 9.0 - uTime * 1.7)));
    float foam = smoothstep(0.72, 0.94, flow + threads * 0.35);
    vec3 water = mix(vec3(0.22, 0.55, 0.66), vec3(0.66, 0.87, 0.85), flow * 0.9);
    water = mix(water, vec3(1.0, 0.93, 0.78), foam * 0.7);
    water = mix(water, vec3(0.34, 0.45, 0.64), uNight * 0.55);
    float alpha = edge * top * down * (0.36 + foam * 0.52);
    alpha *= 0.82;
    float dist = distance(vWorld, cameraPosition);
    float fog = 1.0 - exp(-dist * dist * 0.00000065);
    water = mix(water, uFogColor, clamp(fog, 0.0, 0.7));
    gl_FragColor = vec4(water, alpha);
  }
`;

function colorGeometry(geometry, color) {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = nonIndexed.attributes.position.count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col[i * 3] = color.r;
    col[i * 3 + 1] = color.g;
    col[i * 3 + 2] = color.b;
  }
  nonIndexed.setAttribute("color", new THREE.BufferAttribute(col, 3));
  nonIndexed.deleteAttribute("uv");
  if (!nonIndexed.attributes.normal) nonIndexed.computeVertexNormals();
  return nonIndexed;
}

function mergeColored(parts, matrix, color) {
  const geo = colorGeometry(parts, color);
  geo.applyMatrix4(matrix);
  return geo;
}

const TREE_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.98,
  metalness: 0,
  flatShading: true,
});

function buildTreeVariant(rng, type) {
  const parts = [];
  const m = new THREE.Matrix4();
  const trunkColor = new THREE.Color().setHSL(0.055 + rng() * 0.022, 0.32, 0.25 + rng() * 0.08);
  const trunkHeight = type === "blossom" ? 1.7 + rng() * 1.2 : 2.0 + rng() * 1.4;
  const trunk = new THREE.CylinderGeometry(0.18, 0.34, trunkHeight, 5);
  parts.push(mergeColored(trunk, m.clone().makeTranslation(0, trunkHeight / 2, 0), trunkColor));

  if (type === "blossom") {
    const hues = [0.98, 1.02, 0.045, 0.06];
    const count = 4 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const d = i === 0 ? 0 : 0.55 + rng() * 1.25;
      const r = 0.72 + rng() * 0.68;
      const geo = new THREE.IcosahedronGeometry(r, 0);
      const col = new THREE.Color().setHSL(hues[Math.floor(rng() * hues.length)], 0.5, 0.57 + rng() * 0.13);
      matrixCompose(m, Math.cos(a) * d, trunkHeight + rng() * 1.5, Math.sin(a) * d, r * (0.85 + rng() * 0.3));
      parts.push(mergeColored(geo, m, col));
    }
    // A little golden crown.
    const crown = new THREE.IcosahedronGeometry(0.55 + rng() * 0.3, 0);
    parts.push(
      mergeColored(
        crown,
        m.clone().makeTranslation(0.2, trunkHeight + 1.8, -0.1),
        new THREE.Color().setHSL(0.1, 0.54, 0.67)
      )
    );
  } else {
    const greens = [0.22, 0.24, 0.2];
    const layers = 3;
    for (let i = 0; i < layers; i++) {
      const r = 1.35 - i * 0.28 + rng() * 0.12;
      const h = 2.2 - i * 0.2;
      const cone = new THREE.ConeGeometry(r, h, 7);
      const col = new THREE.Color().setHSL(greens[i % greens.length], 0.34, 0.31 + i * 0.055);
      parts.push(
        mergeColored(
          cone,
          m.clone().makeTranslation(0, trunkHeight + 0.35 + i * 0.88, 0),
          col
        )
      );
    }
  }
  return mergeGeometries(parts, false);
}

function matrixCompose(m, x, y, z, scale = 1, rotY = 0) {
  const q = new THREE.Quaternion().setFromAxisAngle(UP, rotY);
  return m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, scale, scale));
}

const TREE_VARIANTS = [];
{
  const rng = mulberry32(11003);
  for (let i = 0; i < 4; i++) TREE_VARIANTS.push(buildTreeVariant(rng, "conifer"));
  for (let i = 0; i < 4; i++) TREE_VARIANTS.push(buildTreeVariant(rng, "blossom"));
}

const ROCK_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 1,
  metalness: 0,
  flatShading: true,
});

const glowTexture = createGlowTexture();
const softDiscTexture = createSoftDiscTexture("rgba(255,255,255,0.95)", "rgba(255,255,255,0)");

const WATERFALL_MATERIAL = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color(0xf0ad90) },
    uNight: { value: 0 },
  },
  vertexShader: waterfallVertex,
  fragmentShader: waterfallFragment,
});

/* ————————————————————————————————————————————————
   Floating island
   ———————————————————————————————————————————————— */

const GRASS_COLORS = [
  new THREE.Color(0x8fa95e),
  new THREE.Color(0xa2b262),
  new THREE.Color(0xb8b268),
  new THREE.Color(0x7d9a60),
  new THREE.Color(0xc3a860),
];
const ROCK_COLORS = [
  new THREE.Color(0xb87a5e),
  new THREE.Color(0x9c6357),
  new THREE.Color(0x856070),
  new THREE.Color(0xc08a66),
  new THREE.Color(0x705a76),
  new THREE.Color(0x9d7468),
];

function topRimNoise(a, seed) {
  return (
    1 +
    0.095 * Math.sin(a * 3 + seed * 1.7) +
    0.055 * Math.sin(a * 7.3 + seed * 4.2) +
    0.032 * Math.sin(a * 13.1 + seed * 8.9)
  );
}

export class Island {
  constructor(seed, radius, depth, style = "normal", fallAngle = Math.PI) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.radius = radius;
    this.depth = depth;
    this.style = style;
    this.fallAngle = fallAngle;
    this.topHeight = 2.8 + radius * 0.105;
    this.group = new THREE.Group();
    this.group.name = "floating-island";
    this.floaters = [];
    this.mists = [];
    this.waterfalls = [];
    this.seedAngle = this.rng() * TAU;

    this.buildLand();
    this.buildWaterfall();
    this.buildTrees();
    if (this.rng() < 0.58) this.buildCottage();
    this.buildFloatingRocks();
    this.collision = {
      topRadius: radius * 0.82,
      bodyRadius: radius * 0.6,
      depth,
      height: this.topHeight,
    };
  }

  rimRadius(a, inner = 1) {
    return this.radius * inner * topRimNoise(a, this.seed);
  }

  topHeightAt(x, z) {
    const d = Math.sqrt(x * x + z * z) / this.radius;
    return this.topHeight * (1 - Math.pow(clamp(d, 0, 1), 1.55)) + 0.15;
  }

  buildLand() {
    const seg = 72;
    const rings = 13;
    const positions = [];
    const colors = [];
    const indices = [];

    // Center.
    positions.push(0, this.topHeight, 0);
    const centerColor = GRASS_COLORS[0].clone().offsetHSL(
      (this.rng() - 0.5) * 0.02,
      (this.rng() - 0.5) * 0.06,
      -0.02 + (this.rng() - 0.5) * 0.05
    );
    colors.push(centerColor.r, centerColor.g, centerColor.b);

    for (let r = 1; r <= rings; r++) {
      const t = r / rings;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * TAU;
        const rim = this.rimRadius(a);
        const rr = rim * t;
        const n = fbm2(Math.cos(a) * 2.2 + this.seed, Math.sin(a) * 2.2 + t * 3.1, 3);
        const y = this.topHeight * (1 - Math.pow(t, 1.55)) + (n - 0.5) * 0.55 * t + 0.05;
        positions.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
        let c;
        if (t < 0.55) {
          c = GRASS_COLORS[0].clone().lerp(GRASS_COLORS[3], n * 0.7);
        } else {
          c = GRASS_COLORS[1].clone().lerp(GRASS_COLORS[2], smoothstep(0.55, 1, t) * (0.45 + n * 0.55));
        }
        c.offsetHSL((n - 0.5) * 0.02, (n - 0.5) * 0.08, (n - 0.5) * 0.07);
        colors.push(c.r, c.g, c.b);
      }
    }

    for (let s = 0; s < seg; s++) {
      indices.push(0, 1 + ((s + 1) % seg), 1 + s);
    }
    for (let r = 1; r < rings; r++) {
      const baseA = 1 + (r - 1) * seg;
      const baseB = 1 + r * seg;
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        indices.push(baseA + s, baseA + s2, baseB + s);
        indices.push(baseA + s2, baseB + s2, baseB + s);
      }
    }
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    topGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    topGeo.setIndex(indices);
    topGeo.computeVertexNormals();
    const topMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      flatShading: false,
    });
    this.top = new THREE.Mesh(topGeo, topMat);
    this.top.receiveShadow = true;
    this.top.castShadow = true;
    this.group.add(this.top);

    // The underside — layered bands of rose, umber and dusk.
    const under = [];
    const underColors = [];
    const underIndices = [];
    const levels = 16;
    for (let l = 0; l <= levels; l++) {
      const t = l / levels;
      const profile = Math.pow(1 - t, 0.58);
      const ledges = 1 + 0.075 * Math.sin(t * 19 + this.seed) * (1 - t) + 0.025 * Math.sin(t * 47);
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * TAU;
        const rim = this.rimRadius(a, 1.015);
        const rr = rim * profile * (l === 0 ? 1.012 : ledges);
        const twist = t * 0.15;
        const y = -this.depth * Math.pow(t, 1.12) + (l === 0 ? -0.25 : 0);
        under.push(Math.cos(a + twist) * rr, y, Math.sin(a + twist) * rr);

        const band = fbm2(Math.cos(a) * 2.7 + t * 4.1 + this.seed, t * 8.4 + Math.sin(a) * 1.4, 4);
        const idxA = Math.floor(band * (ROCK_COLORS.length - 1));
        const idxB = Math.min(ROCK_COLORS.length - 1, idxA + 1);
        const c = ROCK_COLORS[idxA].clone().lerp(ROCK_COLORS[idxB], (band * 2.3) % 1);
        c.offsetHSL((band - 0.5) * 0.02, (band - 0.5) * 0.07, -t * 0.1 + (band - 0.5) * 0.07);
        underColors.push(c.r, c.g, c.b);
      }
    }
    for (let l = 0; l < levels; l++) {
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        const a = l * seg;
        const b = (l + 1) * seg;
        underIndices.push(a + s, a + s2, b + s);
        underIndices.push(a + s2, b + s2, b + s);
      }
    }
    const underGeo = new THREE.BufferGeometry();
    underGeo.setAttribute("position", new THREE.Float32BufferAttribute(under, 3));
    underGeo.setAttribute("color", new THREE.Float32BufferAttribute(underColors, 3));
    underGeo.setIndex(underIndices);
    underGeo.computeVertexNormals();
    this.rock = new THREE.Mesh(
      underGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true })
    );
    this.rock.castShadow = true;
    this.rock.receiveShadow = true;
    this.group.add(this.rock);

    // Tiny hanging roots in the shallows of the island.
    const rootMat = new THREE.LineBasicMaterial({
      color: 0x5d6047,
      transparent: true,
      opacity: 0.55,
    });
    const rootPositions = [];
    const rootCount = 8 + Math.floor(this.rng() * 8);
    for (let i = 0; i < rootCount; i++) {
      const a = this.rng() * TAU;
      const rad = this.rimRadius(a) * 0.9;
      const sx = Math.cos(a) * rad;
      const sz = Math.sin(a) * rad;
      const len = 2 + this.rng() * 7;
      const x2 = sx + Math.cos(a) * (1 + this.rng() * 4);
      const z2 = sz + Math.sin(a) * (1 + this.rng() * 4);
      rootPositions.push(sx, -0.2, sz, x2, -len, z2);
    }
    const rootGeo = new THREE.BufferGeometry();
    rootGeo.setAttribute("position", new THREE.Float32BufferAttribute(rootPositions, 3));
    this.group.add(new THREE.LineSegments(rootGeo, rootMat));
  }

  buildWaterfall() {
    const rng = this.rng;
    const angle = this.fallAngle + (rng() - 0.5) * 0.35;
    const outX = Math.cos(angle);
    const outZ = Math.sin(angle);
    const tangentX = -outZ;
    const tangentZ = outX;
    const rim = this.rimRadius(angle) * 0.94;
    const startX = outX * rim;
    const startZ = outZ * rim;
    const fallHeight = 58 + rng() * 44;
    const layers = 2;
    for (let layer = 0; layer < layers; layer++) {
      const steps = 26;
      const positions = [];
      const uvs = [];
      const indices = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const out = t * (9 + layer * 4) + Math.sin(t * Math.PI) * 5.0;
        const y = 0.15 - t * fallHeight + Math.sin(t * 9 + layer * 2) * 0.45;
        const width = (3.0 + layer * 0.7 + t * 8.5) * (0.75 + 0.25 * Math.sin(t * 7 + layer));
        const px = startX + outX * out + tangentX * width;
        const pz = startZ + outZ * out + tangentZ * width;
        const px2 = startX + outX * out - tangentX * width;
        const pz2 = startZ + outZ * out - tangentZ * width;
        positions.push(px, y, pz, px2, y, pz2);
        uvs.push(0, t, 1, t);
      }
      for (let i = 0; i < steps; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mesh = new THREE.Mesh(geo, WATERFALL_MATERIAL);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.waterfalls.push(mesh);
    }

    // A still turquoise pool at the lip.
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(2.7 + rng() * 1.4, 20),
      new THREE.MeshStandardMaterial({
        color: 0x90d2cb,
        roughness: 0.25,
        metalness: 0.15,
        emissive: 0x2f6d72,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.9,
      })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.scale.y = 0.7;
    pool.position.set(startX - outX * 2.4, 0.33, startZ - outZ * 2.4);
    this.group.add(pool);

    // Mist gathering where the water dissolves into the cloud sea.
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.SpriteMaterial({
        map: softDiscTexture,
        color: 0xcfe5d7,
        transparent: true,
        opacity: 0.12 + i * 0.035,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mist = new THREE.Sprite(mat);
      const spread = (rng() - 0.5) * 10;
      mist.position.set(
        startX + outX * (14 + i * 3) + tangentX * spread,
        -fallHeight + 8 + i * 5,
        startZ + outZ * (14 + i * 3) + tangentZ * spread
      );
      mist.scale.setScalar(12 + i * 7);
      this.group.add(mist);
      this.mists.push({ sprite: mist, base: mist.position.y, phase: rng() * TAU });
    }
    this.fallBottom = -fallHeight + 10;
  }

  buildTrees() {
    const rng = this.rng;
    const count = Math.floor(this.radius / 4.3) + 3;
    const treeGeos = [];
    const angleW = this.fallAngle;
    for (let i = 0; i < count; i++) {
      let a = rng() * TAU;
      let r = Math.pow(rng(), 0.62) * this.radius * 0.68;
      // Keep the pool and the centre path clear.
      let da = Math.abs(Math.atan2(Math.sin(a - angleW), Math.cos(a - angleW)));
      if (da < 0.55) r *= 0.55;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.topHeightAt(x, z);
      const variant = TREE_VARIANTS[Math.floor(rng() * TREE_VARIANTS.length)];
      const scale = (0.8 + rng() * 1.1) * clamp(this.radius / 38, 0.72, 1.5);
      const geo = variant.clone();
      const m = new THREE.Matrix4();
      const quat = new THREE.Quaternion().setFromAxisAngle(UP, rng() * TAU);
      m.compose(new THREE.Vector3(x, y - 0.1, z), quat, new THREE.Vector3(scale, scale, scale));
      geo.applyMatrix4(m);
      treeGeos.push(geo);
    }
    // A shaggy fringe of grass tufts softens the island's silhouette.
    const fringeCount = 16 + Math.floor(rng() * 10);
    for (let i = 0; i < fringeCount; i++) {
      const a = (i / fringeCount) * TAU + rng() * 0.2;
      const r = this.rimRadius(a) * (0.9 + rng() * 0.12);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.topHeightAt(x, z) - 0.5;
      const h = 1.4 + rng() * 2.8;
      const cone = new THREE.ConeGeometry(0.55 + rng() * 0.8, h, 4);
      const col = GRASS_COLORS[2 + Math.floor(rng() * 3)].clone();
      col.offsetHSL(0, (rng() - 0.5) * 0.1, -0.12 - rng() * 0.1);
      const m = new THREE.Matrix4();
      const quat = new THREE.Quaternion().setFromAxisAngle(UP, rng() * TAU);
      m.compose(
        new THREE.Vector3(x, y + h * 0.32, z),
        quat,
        new THREE.Vector3(1, 1 + rng() * 0.5, 1)
      );
      treeGeos.push(mergeColored(cone, m, col));
    }
    if (treeGeos.length) {
      const merged = mergeGeometries(treeGeos, false);
      const trees = new THREE.Mesh(merged, TREE_MATERIAL);
      trees.castShadow = true;
      trees.receiveShadow = true;
      this.trees = trees;
      this.group.add(trees);
    }
  }

  buildCottage() {
    const rng = this.rng;
    const a = rng() * TAU;
    const r = this.radius * (0.18 + rng() * 0.26);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = this.topHeightAt(x, z) + 0.05;
    const cottage = new THREE.Group();
    cottage.position.set(x, y, z);
    cottage.rotation.y = rng() * TAU;

    const wallGeo = colorGeometry(new THREE.BoxGeometry(2.8, 1.9, 2.2), new THREE.Color(0xe7c69b));
    const walls = new THREE.Mesh(wallGeo, ROCK_MATERIAL);
    walls.position.y = 0.95;
    walls.castShadow = true;
    cottage.add(walls);

    const roofGeo = colorGeometry(new THREE.ConeGeometry(2.35, 1.8, 4), new THREE.Color(0x9e5550));
    const roof = new THREE.Mesh(roofGeo, ROCK_MATERIAL);
    roof.position.y = 2.75;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    cottage.add(roof);

    const chimneyGeo = colorGeometry(new THREE.BoxGeometry(0.42, 1.1, 0.42), new THREE.Color(0x7e5b5c));
    const chimney = new THREE.Mesh(chimneyGeo, ROCK_MATERIAL);
    chimney.position.set(0.8, 2.65, 0.3);
    cottage.add(chimney);

    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd17a, toneMapped: false });
    const windowGeo = new THREE.PlaneGeometry(0.62, 0.72);
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(windowGeo, glowMat);
      win.position.set(side * 1.41, 1.15, 0);
      win.rotation.y = side * Math.PI * 0.5;
      cottage.add(win);
    }
    const chimneySmoke = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: softDiscTexture,
        color: 0xf7e4c7,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      })
    );
    chimneySmoke.position.set(0.8, 3.6, 0.3);
    chimneySmoke.scale.setScalar(2.8);
    cottage.add(chimneySmoke);
    this.smoke = chimneySmoke;
    this.smokeBase = 3.6;
    this.group.add(cottage);
    this.cottage = cottage;
  }

  buildFloatingRocks() {
    const rng = this.rng;
    const count = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU;
      const dist = this.radius * (0.55 + rng() * 0.65);
      const s = 1.2 + rng() * 4.2;
      const geo = new THREE.DodecahedronGeometry(s, 0);
      const col = ROCK_COLORS[Math.floor(rng() * ROCK_COLORS.length)].clone();
      col.offsetHSL(0, -0.03, -0.04 + rng() * 0.06);
      const rockGeo = colorGeometry(geo, col);
      const mesh = new THREE.Mesh(rockGeo, ROCK_MATERIAL);
      const baseY = -6 - rng() * this.depth * 0.55;
      mesh.position.set(Math.cos(a) * dist, baseY, Math.sin(a) * dist);
      mesh.scale.set(1, 0.7 + rng() * 0.7, 0.8 + rng() * 0.5);
      mesh.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.floaters.push({ mesh, baseY, phase: rng() * TAU, amp: 0.7 + rng() * 2.2 });
    }
  }

  update(dt, time) {
    for (const f of this.floaters) {
      f.mesh.position.y = f.baseY + Math.sin(time * 0.35 + f.phase) * f.amp;
      f.mesh.rotation.y += dt * 0.035;
    }
    for (const m of this.mists) {
      m.sprite.position.y = m.base + Math.sin(time * 0.32 + m.phase) * 2.2;
      const s = 12 + Math.sin(time * 0.2 + m.phase) * 2.4;
      m.sprite.scale.setScalar(s);
      m.sprite.material.opacity = 0.1 + Math.sin(time * 0.25 + m.phase) * 0.03;
    }
    if (this.smoke) {
      this.smoke.position.y = this.smokeBase + Math.sin(time * 0.5) * 0.1;
      this.smoke.material.opacity = 0.1 + Math.sin(time * 0.4) * 0.025;
    }
  }
}

/* ————————————————————————————————————————————————
   Golden rings
   ———————————————————————————————————————————————— */

const ringVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const ringFragment = /* glsl */ `
  uniform float uTime;
  uniform float uHighlight;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vView;
  void main() {
    float pulse = 0.8 + 0.2 * sin(uTime * 2.3 + vUv.x * 9.0);
    vec3 gold = vec3(1.0, 0.67, 0.26);
    vec3 rose = vec3(1.0, 0.42, 0.33);
    vec3 cream = vec3(1.0, 0.91, 0.67);
    vec3 col = mix(gold, rose, smoothstep(0.1, 0.9, vUv.y));
    col = mix(col, cream, pow(sin(vUv.x * 3.14159 * 3.0), 8.0) * 0.35);
    col *= pulse * (0.9 + uHighlight * 0.55);
    gl_FragColor = vec4(col, 0.85 * uOpacity);
  }
`;

export class GoldenRing {
  constructor(seed, distance, center, normal, radius) {
    this.seed = seed;
    this.distance = distance;
    this.radius = radius;
    this.center = center.clone();
    this.normal = normal.clone().normalize();
    this.state = "active";
    this.collectTime = 0;
    this.group = new THREE.Group();
    this.group.position.copy(center);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);

    this.coreMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uHighlight: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
    });
    this.core = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.25, 10, 96), this.coreMaterial);
    this.core.renderOrder = 5;
    this.group.add(this.core);

    this.haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9a50,
      transparent: true,
      opacity: 0.085,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.62, 10, 96), this.haloMaterial);
    this.halo.renderOrder = 4;
    this.group.add(this.halo);

    const glowMat = new THREE.SpriteMaterial({
      map: softDiscTexture,
      color: 0xffa860,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.aura = new THREE.Sprite(glowMat);
    this.aura.scale.setScalar(radius * 2.4);
    this.aura.renderOrder = 3;
    this.group.add(this.aura);

    // Little fireflies strung around the hoop.
    const sparkCount = 12;
    const positions = new Float32Array(sparkCount * 3);
    for (let i = 0; i < sparkCount; i++) {
      const a = (i / sparkCount) * TAU + seed;
      positions[i * 3] = Math.cos(a) * radius;
      positions[i * 3 + 1] = Math.sin(a) * radius;
      positions[i * 3 + 2] = Math.sin(a * 3 + seed) * 0.4;
    }
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.sparks = new THREE.Points(
      sparkGeo,
      new THREE.PointsMaterial({
        map: glowTexture,
        color: 0xffe5aa,
        size: 1.15,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
      })
    );
    this.sparks.renderOrder = 6;
    this.group.add(this.sparks);
    this.sparkGroup = this.sparks;
  }

  setNext(active) {
    this.nextTarget = active;
  }

  update(dt, time) {
    this.coreMaterial.uniforms.uTime.value = time;
    this.coreMaterial.uniforms.uHighlight.value = this.nextTarget ? 1 : 0;
    this.sparks.rotation.z += dt * (this.nextTarget ? 0.35 : 0.16);
    const pulse = 1 + Math.sin(time * 1.7 + this.seed) * 0.018;
    this.core.scale.setScalar(pulse);
    this.halo.scale.setScalar(1 + Math.sin(time * 1.1 + this.seed) * 0.04);
    this.haloMaterial.opacity = (this.nextTarget ? 0.2 : 0.1) + Math.sin(time * 1.3 + this.seed) * 0.025;
    this.aura.material.opacity = (this.nextTarget ? 0.16 : 0.09) + Math.sin(time * 1.2 + this.seed) * 0.02;

    if (this.state === "collected" || this.state === "skipped") {
      this.collectTime += dt;
      const t = this.collectTime;
      const skipped = this.state === "skipped";
      const fade = skipped ? 2.4 : 1.3;
      const s = skipped ? 1 : 1 + t * 2.2;
      this.group.scale.setScalar(s);
      this.coreMaterial.uniforms.uOpacity.value = Math.max(0, 1 - t * fade);
      this.haloMaterial.opacity = Math.max(0, (skipped ? 0.16 : 0.3) * (1 - t * fade));
      this.aura.material.opacity = Math.max(0, (skipped ? 0.14 : 0.3) * (1 - t * fade));
      this.sparks.material.opacity = Math.max(0, (skipped ? 0.55 : 0.85) * (1 - t * fade));
      if (t > (skipped ? 0.62 : 1.25)) this.group.visible = false;
    }
  }
}

/* ————————————————————————————————————————————————
   Particle bursts
   ———————————————————————————————————————————————— */

function makeBurstMaterial(color, opacity = 1) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (110.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
        vAlpha = aSize;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d));
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `,
  });
}

export class Bursts {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
  }

  spawn(position, color = 0xffd28b, power = 1) {
    const count = 46;
    const positions = new Float32Array(count * 3);
    const velocities = [];
    const sizes = new Float32Array(count);
    const rng = Math.random;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
      velocities.push(dir.multiplyScalar((5 + rng() * 18) * power));
      sizes[i] = 0.8 + rng() * 2.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    const mat = makeBurstMaterial(color);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 8;
    this.scene.add(points);
    this.list.push({ points, geo, mat, velocities, age: 0, life: 1.6 });
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.age += dt;
      const pos = b.geo.attributes.position.array;
      for (let j = 0; j < b.velocities.length; j++) {
        const v = b.velocities[j];
        v.multiplyScalar(0.96);
        v.y -= 4 * dt;
        pos[j * 3] += v.x * dt;
        pos[j * 3 + 1] += v.y * dt;
        pos[j * 3 + 2] += v.z * dt;
      }
      b.geo.attributes.position.needsUpdate = true;
      const t = b.age / b.life;
      b.mat.uniforms.uOpacity.value = Math.max(0, 1 - t) * 0.95;
      if (b.age >= b.life) {
        this.scene.remove(b.points);
        b.geo.dispose();
        b.mat.dispose();
        this.list.splice(i, 1);
      }
    }
  }
}

/* ————————————————————————————————————————————————
   Birds
   ———————————————————————————————————————————————— */

const birdBodyGeo = new THREE.ConeGeometry(0.14, 0.95, 4);
birdBodyGeo.rotateX(-Math.PI / 2);
birdBodyGeo.translate(0, 0, -0.18);
const birdWingGeo = (() => {
  const g = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    0, 0, 0.18,
    -1.25, 0, -0.28,
    0, 0, -0.52,
  ]);
  g.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  g.computeVertexNormals();
  return g;
})();
const BIRD_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x34283d,
  roughness: 0.9,
  metalness: 0,
  side: THREE.DoubleSide,
  emissive: 0x251c30,
  emissiveIntensity: 0.5,
});

class Bird {
  constructor() {
    this.group = new THREE.Group();
    this.body = new THREE.Mesh(birdBodyGeo, BIRD_MATERIAL);
    this.left = new THREE.Mesh(birdWingGeo, BIRD_MATERIAL);
    this.right = new THREE.Mesh(birdWingGeo, BIRD_MATERIAL);
    this.right.scale.x = -1;
    this.group.add(this.body, this.left, this.right);
    this.phase = Math.random() * TAU;
    this.flapSpeed = 6.5 + Math.random() * 3.5;
    this.scale = 0.65 + Math.random() * 0.75;
    this.group.scale.setScalar(this.scale);
    this.offset = new THREE.Vector3(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 24
    );
  }

  update(time, heading) {
    const flap = Math.sin(time * this.flapSpeed + this.phase);
    this.left.rotation.z = 0.12 + flap * 0.5;
    this.right.rotation.z = -0.12 - flap * 0.5;
    this.left.rotation.x = flap * 0.13;
    this.right.rotation.x = flap * 0.13;
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), heading);
  }
}

export class Flock {
  constructor(seed, center) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.center = center.clone();
    this.radius = 18 + this.rng() * 28;
    this.height = 8 + this.rng() * 22;
    this.speed = 0.08 + this.rng() * 0.06;
    this.phase = this.rng() * TAU;
    this.group = new THREE.Group();
    this.birds = [];
    const count = 9 + Math.floor(this.rng() * 7);
    for (let i = 0; i < count; i++) this.birds.push(new Bird());
    for (const b of this.birds) this.group.add(b.group);
    this._heading = new THREE.Vector3();
    this._old = new THREE.Vector3();
    this._new = new THREE.Vector3();
  }

  update(dt, time) {
    const orbit = time * this.speed + this.phase;
    this._new.set(
      this.center.x + Math.cos(orbit) * this.radius,
      this.center.y + this.height + Math.sin(orbit * 1.7 + this.phase) * 4,
      this.center.z + Math.sin(orbit) * this.radius * 0.8
    );
    this._old.set(
      this.center.x + Math.cos(orbit - 0.03) * this.radius,
      this.center.y + this.height + Math.sin((orbit - 0.03) * 1.7 + this.phase) * 4,
      this.center.z + Math.sin(orbit - 0.03) * this.radius * 0.8
    );
    this._heading.subVectors(this._new, this._old).normalize();
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const bx = this._new.x + b.offset.x + Math.sin(time * 0.8 + b.phase) * 0.5;
      const by = this._new.y + b.offset.y + Math.cos(time * 0.9 + b.phase) * 0.4;
      const bz = this._new.z + b.offset.z;
      b.group.position.set(bx - this._new.x, by - this._new.y, bz - this._new.z);
      b.update(time, this._heading);
    }
    this.group.position.copy(this._new);
    this.group.rotation.y = 0;
  }
}

/* ————————————————————————————————————————————————
   The world manager
   ———————————————————————————————————————————————— */

export class World {
  constructor(scene, camera, options = {}) {
    this.scene = scene;
    this.camera = camera;
    this.sky = new SkyDome(scene);
    this.clouds = new CloudField(scene, options.cloudCount ?? 640);
    this.cloudSea = new CloudSea(scene);
    this.bursts = new Bursts(scene);
    this.islands = [];
    this.rings = [];
    this.flocks = [];
    this.ringSpacing = 68;
    this.firstRing = 74;
    this.ringCounter = 0;
    this.islandCounter = 0;
    this.generatedRings = 0;
    this.generatedIslands = 0;
    this.nextFlockDistance = 330;
    this.currentProgress = 0;
    this.time = 0;
    this.sharedTimeUniform = WATERFALL_MATERIAL.uniforms.uTime;

    // The first island is composed to sit in the opening shot.
    this.spawnIsland({ distance: 108, forcedSide: -1, style: "hero", radius: 54, depth: 62 });
    this.spawnIsland({ distance: 245, forcedSide: 1, style: "tall", radius: 42, depth: 72 });
    this.spawnRing(this.firstRing);
    this.spawnFlock(150);
    this.ensureAhead(760);
  }

  get maxDistance() {
    return Math.max(0, -this.currentProgress);
  }

  setDaylight(daylight) {
    const sky = this.sky.material.uniforms;
    sky.uSunDirection.value.copy(daylight.sunDirection);
    sky.uMoonDirection.value.copy(daylight.moonDirection);
    sky.uTop.value.copy(daylight.skyTop);
    sky.uUpper.value.copy(daylight.skyUpper);
    sky.uHorizon.value.copy(daylight.skyHorizon);
    sky.uBottom.value.copy(daylight.skyBottom);
    sky.uSun.value.copy(daylight.skySun);
    sky.uNight.value = daylight.night;

    const clouds = this.clouds.material.uniforms;
    clouds.uSun.value.copy(daylight.cloudSun);
    clouds.uFogColor.value.copy(daylight.cloudFog);
    clouds.uNight.value = daylight.night;

    const sea = this.cloudSea.material.uniforms;
    sea.uSunDirection.value.copy(daylight.sunDirection);
    sea.uFogColor.value.copy(daylight.seaFog);
    sea.uDeep.value.copy(daylight.seaDeep);
    sea.uLit.value.copy(daylight.seaLit);
    sea.uRose.value.copy(daylight.seaRose);

    const waterfall = WATERFALL_MATERIAL.uniforms;
    waterfall.uFogColor.value.copy(daylight.waterfallFog);
    waterfall.uNight.value = daylight.night;
  }

  ensureAhead(position) {
    const d = Math.max(0, -position.z);
    this.currentProgress = d;
    const ahead = d + 1550;

    while (this.firstRing + this.generatedRings * this.ringSpacing < ahead) {
      this.spawnRing(this.firstRing + this.generatedRings * this.ringSpacing);
    }
    while (this.lastIslandDistance === undefined || this.lastIslandDistance < ahead) {
      this.spawnNextIsland();
    }
    while (this.nextFlockDistance < ahead) {
      this.spawnFlock(this.nextFlockDistance);
      this.nextFlockDistance += 300 + Math.random() * 220;
    }

    // Keep the wake clean and the memory bounded.
    const cutoff = d - 240;
    for (let i = this.islands.length - 1; i >= 0; i--) {
      const isl = this.islands[i];
      if (isl.distance < cutoff) {
        this.scene.remove(isl.group);
        this.disposeIsland(isl);
        this.islands.splice(i, 1);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      if (ring.distance < cutoff) {
        this.scene.remove(ring.group);
        this.disposeRing(ring);
        this.rings.splice(i, 1);
      }
    }
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const f = this.flocks[i];
      if (f.center.z > position.z + 500) {
        this.scene.remove(f.group);
        this.flocks.splice(i, 1);
      }
    }
  }

  spawnNextIsland() {
    this.islandCounter++;
    const prev = this.lastIslandDistance ?? 60;
    const distance = prev + 88 + Math.random() * 58;
    this.spawnIsland({ distance });
    this.lastIslandDistance = distance;
  }

  spawnIsland(opts = {}) {
    const distance = opts.distance;
    const rng = mulberry32(9100 + this.islands.length * 41 + Math.floor(distance));
    const side = opts.forcedSide ?? (this.islandCounter % 2 === 0 ? 1 : -1);
    const style = opts.style ?? (rng() < 0.18 ? "distant" : rng() < 0.32 ? "small" : "normal");
    let radius;
    let depth;
    if (style === "hero") {
      radius = opts.radius ?? 54;
      depth = opts.depth ?? 64;
    } else if (style === "tall") {
      radius = opts.radius ?? 41;
      depth = opts.depth ?? 76;
    } else if (style === "distant") {
      radius = 60 + rng() * 44;
      depth = 55 + rng() * 38;
    } else if (style === "small") {
      radius = 17 + rng() * 15;
      depth = 18 + rng() * 26;
    } else {
      radius = 30 + rng() * 25;
      depth = 35 + rng() * 38;
    }
    const p = coursePoint(distance);
    const right = courseRight(distance);
    const lateral =
      (style === "distant" ? 260 + rng() * 220 : radius + 66 + rng() * 160) *
      side;
    const pos = p.clone().addScaledVector(right, lateral);
    pos.y +=
      (style === "distant" ? -55 - rng() * 45 : (rng() - 0.42) * 82) +
      (style === "hero" ? 4 : 0);
    const island = new Island(
      2100 + this.islandCounter * 17 + Math.floor(rng() * 100),
      radius,
      depth,
      style,
      side > 0 ? Math.PI : 0
    );
    island.group.position.copy(pos);
    // A little yaw variation, keeping the whole thing hand-placed.
    island.group.rotation.y = (rng() - 0.5) * 0.7;
    if (island.waterfalls.length) {
      island.group.rotation.y += side > 0 ? -0.15 : 0.15;
    }
    island.distance = distance;
    island.side = side;
    island.radiusValue = radius;
    island.depthValue = depth;
    island.group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.scene.add(island.group);
    this.islands.push(island);
    this.lastIslandDistance = Math.max(this.lastIslandDistance ?? 0, distance);
    this.islandCounter++;
    return island;
  }

  spawnRing(distance) {
    const p = coursePoint(distance);
    p.y += Math.sin(distance * 0.031) * 2.4;
    const tangent = courseTangent(distance);
    const radius = 10.6 + Math.sin(distance * 0.017) * 1.4;
    const ring = new GoldenRing(1900 + this.ringCounter * 7, distance, p, tangent, radius);
    ring.group.traverse((child) => {
      if (child.isMesh) {
        child.frustumCulled = false;
      }
    });
    this.scene.add(ring.group);
    this.rings.push(ring);
    this.ringCounter++;
    this.generatedRings++;
    return ring;
  }

  spawnFlock(distance) {
    const p = coursePoint(distance);
    const right = courseRight(distance);
    p.addScaledVector(right, (Math.random() - 0.5) * 160);
    p.y += 18 + Math.random() * 35;
    const flock = new Flock(5000 + this.flocks.length * 13, p);
    this.scene.add(flock.group);
    this.flocks.push(flock);
  }

  disposeIsland(island) {
    island.group.traverse((child) => {
      if (child.isMesh || child.isLine || child.isPoints) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          // Shared materials (waterfalls, trees, rocks) must survive.
          if (
            child.material !== TREE_MATERIAL &&
            child.material !== ROCK_MATERIAL &&
            child.material !== WATERFALL_MATERIAL
          ) {
            child.material?.dispose();
          }
        }
      }
    });
  }

  disposeRing(ring) {
    ring.group.traverse((child) => {
      if (child.isMesh || child.isPoints) {
        child.geometry?.dispose();
        if (child.material && child.material !== BIRD_MATERIAL) child.material.dispose();
      }
    });
  }

  /** The closest uncollected ring, or null. */
  nextRing(position) {
    let best = null;
    let bestScore = Infinity;
    for (const ring of this.rings) {
      if (ring.state !== "active") continue;
      if (ring.distance < this.currentProgress - 70) continue;
      const s = (position.x - ring.center.x) ** 2 + (position.y - ring.center.y) ** 2 + (position.z - ring.center.z) ** 2;
      if (s < bestScore) {
        bestScore = s;
        best = ring;
      }
    }
    return best;
  }

  /**
   * The next hoop ahead of the plane in course order. Unlike nextRing this
   * only considers rings whose plane the plane has not yet crossed, so it is
   * safe for the autopilot to chase.
   */
  nextRingAhead(position) {
    let best = null;
    for (const ring of this.rings) {
      if (ring.state !== "active") continue;
      const s =
        (position.x - ring.center.x) * ring.normal.x +
        (position.y - ring.center.y) * ring.normal.y +
        (position.z - ring.center.z) * ring.normal.z;
      if (s > 1.5) continue;
      if (!best || ring.distance < best.distance) best = ring;
    }
    return best;
  }

  /** The next active hoop after a given one in course order. */
  nextRingAfter(ring) {
    if (!ring) return null;
    let best = null;
    for (const candidate of this.rings) {
      if (candidate.state !== "active") continue;
      if (candidate.distance <= ring.distance + 1) continue;
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    return best;
  }

  /** Fade a hoop out without awarding points or breaking the combo. */
  skipRing(ring) {
    if (!ring || ring.state !== "active") return;
    ring.state = "skipped";
    ring.collectTime = 0;
  }

  /**
   * Check the segment from previous to current position against rings.
   * Returns { collected: [...], missed: [...] }.
   */
  checkRings(previous, current) {
    const collected = [];
    const missed = [];
    for (const ring of this.rings) {
      if (ring.state !== "active") continue;
      if (Math.abs(ring.distance - this.currentProgress) > 170) continue;
      const prevS = _p0.copy(previous).sub(ring.center).dot(ring.normal);
      const currS = _p1.copy(current).sub(ring.center).dot(ring.normal);
      if (prevS < 0 && currS >= 0) {
        const t = prevS / (prevS - currS);
        const hit = previous.clone().lerp(current, clamp(t, 0, 1));
        const radial = hit.sub(ring.center);
        radial.addScaledVector(ring.normal, -radial.dot(ring.normal));
        const r = radial.length();
        if (r < ring.radius * 0.95) {
          ring.state = "collected";
          ring.collectTime = 0;
          ring.accuracy = 1 - r / ring.radius;
          this.bursts.spawn(ring.center, 0xffd28b, 1.2);
          this.bursts.spawn(ring.center, 0xff9a75, 0.8);
          collected.push(ring);
        } else if (r < ring.radius * 3.5) {
          ring.state = "missed";
          missed.push(ring);
        }
      }
    }
    return { collected, missed };
  }

  /** Approximate island collision. Returns a surface normal to push along, or null. */
  collide(position) {
    for (const island of this.islands) {
      const g = island.group.position;
      const dx = position.x - g.x;
      const dz = position.z - g.z;
      const horizontal = Math.sqrt(dx * dx + dz * dz);
      const topR = island.radiusValue * 0.86;
      const yWithinTop = position.y < g.y + island.collision.height + 1;
      if (yWithinTop && horizontal < topR && position.y > g.y - 1.2) {
        const push = new THREE.Vector3(dx, 0, dz);
        if (push.lengthSq() < 0.001) push.set(1, 0, 0);
        push.normalize().multiplyScalar(0.7);
        push.y = 0.75;
        return push.normalize();
      }
      const cy = g.y - island.depthValue * 0.25;
      const dy = position.y - cy;
      const r = island.radiusValue * 0.55;
      if (dx * dx + dy * dy + dz * dz < r * r) {
        const push = new THREE.Vector3(dx, dy, dz).normalize();
        if (push.lengthSq() < 0.001) push.set(0, 1, 0);
        return push;
      }
    }
    return null;
  }

  setHighlight(ring) {
    for (const r of this.rings) r.setNext(r === ring);
  }

  update(dt, time, camera) {
    this.time = time;
    this.sharedTimeUniform.value = time;
    this.sky.update(dt, time, camera);
    this.clouds.update(dt, time, camera);
    this.cloudSea.update(dt, time, camera);
    this.bursts.update(dt);
    for (const island of this.islands) island.update(dt, time);
    for (const ring of this.rings) ring.update(dt, time);
    for (const flock of this.flocks) flock.update(dt, time);
  }
}
