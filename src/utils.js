import * as THREE from "three";

export const TAU = Math.PI * 2;

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  return clamp((v - a) / (b - a), 0, 1);
}

export function smoothstep(a, b, v) {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
}

/** Stronger ease-in-out: slower at both ends, faster through the middle. */
export function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Frame-rate independent exponential damping. */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dampVector(current, target, lambda, dt) {
  return current.lerp(target, 1 - Math.exp(-lambda * dt));
}

export function signedAngle(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x, y, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise2(x * freq, y * freq);
    amplitude *= 0.5;
    freq *= 2.03;
  }
  return value;
}

export function randomPointInSphere(rng, radius) {
  const u = rng();
  const v = rng();
  const w = rng();
  const theta = u * TAU;
  const phi = Math.acos(2 * v - 1);
  const r = Math.cbrt(w) * radius;
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

export function colorLerp(a, b, t) {
  return new THREE.Color().copy(a).lerp(b, t);
}

/**
 * Paints approximate per-vertex color noise onto a geometry.
 * Useful for softening flat-shaded, hand-painted surfaces.
 */
export function tintGeometry(geometry, colorFn) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    colorFn(c, pos.getX(i), pos.getY(i), pos.getZ(i), i);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function makeCanvasTexture(size, draw, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = options.colorSpace ?? THREE.SRGBColorSpace;
  texture.wrapS = options.wrapS ?? THREE.ClampToEdgeWrapping;
  texture.wrapT = options.wrapT ?? THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A soft, slightly irregular watercolour cloud puff. */
export function createCloudTexture() {
  return makeCanvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const rng = mulberry32(9182);
    const blobs = 18;
    for (let i = 0; i < blobs; i++) {
      const a = rng() * TAU;
      const dist = Math.pow(rng(), 0.65) * s * 0.22;
      const x = s * 0.5 + Math.cos(a) * dist;
      const y = s * 0.5 + Math.sin(a) * dist * 0.58;
      const r = s * (0.1 + rng() * 0.18);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.7)");
      g.addColorStop(0.5, "rgba(255,255,255,0.36)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  });
}

/** A tiny round glow used by dust, fireflies and collection bursts. */
export function createGlowTexture() {
  return makeCanvasTexture(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, "rgba(255,248,220,0.95)");
    g.addColorStop(0.5, "rgba(255,196,120,0.32)");
    g.addColorStop(1, "rgba(255,150,80,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

export function createSoftDiscTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  return makeCanvasTexture(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

export function setShadow(object, cast = true, receive = true) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
}
