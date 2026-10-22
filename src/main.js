import "./style.css";
import "@fontsource/cormorant-garamond/300.css";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/300-italic.css";
import "@fontsource/cormorant-garamond/400-italic.css";
import "@fontsource/italianno/400.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/600.css";

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { clamp, damp, easeInOutCubic, lerp, mulberry32, smoothstep, TAU } from "./utils.js";
import { World, SUN_DIRECTION, coursePoint, courseTangent } from "./world.js";
import { PaperPlane } from "./plane.js";
import { Soundscape } from "./audio.js";

const canvas = document.getElementById("scene");

const isCoarse = window.matchMedia("(pointer: coarse)").matches;
const isSmall = Math.min(window.innerWidth, window.innerHeight) < 560;
const pixelRatioLimit = isCoarse || isSmall ? 1.4 : 1.7;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "high-performance",
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioLimit));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xdc9070, 0.00042);

const camera = new THREE.PerspectiveCamera(
  58,
  window.innerWidth / window.innerHeight,
  0.4,
  6000
);
camera.position.set(6, 52, 78);

/* ————— Light ————— */

const hemi = new THREE.HemisphereLight(0xffd4ad, 0x5d4b78, 0.78);
scene.add(hemi);

const sunDirection = SUN_DIRECTION.clone();
const moonDirection = SUN_DIRECTION.clone().negate();

const sun = new THREE.DirectionalLight(0xffd49c, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(isCoarse ? 1024 : 2048, isCoarse ? 1024 : 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 700;
sun.shadow.camera.left = -190;
sun.shadow.camera.right = 190;
sun.shadow.camera.top = 190;
sun.shadow.camera.bottom = -190;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.7;
scene.add(sun);
scene.add(sun.target);

const moon = new THREE.DirectionalLight(0xa9c2ff, 0);
moon.position.copy(moonDirection).multiplyScalar(260);
scene.add(moon);
scene.add(moon.target);

const fill = new THREE.DirectionalLight(0x94a0e8, 0.4);
fill.position.set(-160, 80, 180);
scene.add(fill);

// Warm light scattered back up from the cloud sea.
const bounce = new THREE.DirectionalLight(0xffa878, 0.38);
bounce.position.set(60, -220, 140);
scene.add(bounce);

const skyFill = new THREE.DirectionalLight(0xffab7c, 0.32);
skyFill.position.copy(sunDirection).multiplyScalar(220);
scene.add(skyFill);

/* ————— Post-processing ————— */

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.32,
  0.52,
  0.9
);
composer.addPass(bloom);

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // A whisper of lens softness toward the corners.
      vec2 ca = centered * r2 * 0.0075;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - ca).b;

      // Golden highlights, dusk-violet shadows.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, col * vec3(1.1, 1.0, 0.86), smoothstep(0.04, 0.6, luma) * 0.78);
      col = mix(col, col * vec3(0.86, 0.89, 1.16), smoothstep(0.22, 0.0, luma) * 0.62);
      col = mix(vec3(luma), col, 1.16);
      col = mix(col, col * col * (3.0 - 2.0 * clamp(col, 0.0, 1.0)), 0.32);

      // Unseen grain and a soft vignette hold the frame together.
      float n = hash(gl_FragCoord.xy * 0.75 + fract(uTime) * 91.7);
      col += (n - 0.5) * 0.009;
      float vig = smoothstep(1.22, 0.2, length(centered) * 1.3);
      col *= mix(1.0, vig, uVignette * 0.82) + 0.001;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);
composer.addPass(new SMAAPass());
composer.addPass(new OutputPass());

/* ————— World, plane, sound ————— */

const world = new World(scene, camera, { cloudCount: isCoarse ? 360 : 780 });
const plane = new PaperPlane(scene, camera);
const sound = new Soundscape();

let introDistance = 8;
let introPoint = coursePoint(introDistance);
let introTangent = courseTangent(introDistance);
plane.updateAutopilot(0.016, introPoint, introTangent, 0);
world.ensureAhead(plane.position);
world.setHighlight(world.nextRing(plane.position));

/* ————— Wind streaks & golden motes ————— */

class WindStreaks {
  constructor(scene) {
    this.count = isCoarse ? 44 : 84;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.positions = new Float32Array(this.count * 6);
    this.data = [];
    const rng = mulberry32(5531);
    for (let i = 0; i < this.count; i++) {
      this.data.push({
        x: (rng() - 0.5) * 90,
        y: (rng() - 0.5) * 60,
        z: -260 + rng() * 300,
        len: 5 + rng() * 16,
        speed: 0.6 + rng() * 1.1,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({
      color: 0xffe8c2,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.group.add(this.mesh);
  }

  update(dt, time, plane, speed) {
    this.group.position.copy(plane.position);
    this.group.quaternion.copy(plane.group.quaternion);
    const arr = this.positions;
    for (let i = 0; i < this.count; i++) {
      const d = this.data[i];
      d.z += speed * d.speed * dt;
      if (d.z > 42) {
        d.z = -260 - Math.random() * 60;
        d.x = (Math.random() - 0.5) * 90;
        d.y = (Math.random() - 0.5) * 60;
      }
      const ix = i * 6;
      arr[ix] = d.x;
      arr[ix + 1] = d.y;
      arr[ix + 2] = d.z;
      arr[ix + 3] = d.x;
      arr[ix + 4] = d.y;
      arr[ix + 5] = d.z - d.len * (0.6 + speed * 0.012);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.material.opacity = damp(this.material.opacity, clamp((speed - 14) / 90, 0.02, 0.28), 3, dt);
  }
}

class GoldenMotes {
  constructor(scene, count = 220) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const rng = mulberry32(3177);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);
    this.count = count;
    this.rng = rng;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng() - 0.5) * 220;
      positions[i * 3 + 1] = (rng() - 0.5) * 140;
      positions[i * 3 + 2] = (rng() - 0.5) * 220;
      phases[i] = rng() * Math.PI * 2;
      sizes[i] = 0.6 + rng() * 1.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uColor: { value: new THREE.Color(0xffd794) },
      },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        attribute float aSize;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.22 + aPhase) * 7.0;
          p.y += cos(uTime * 0.18 + aPhase * 1.3) * 5.0;
          p.z += sin(uTime * 0.15 + aPhase * 0.7) * 7.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (70.0 / max(1.0, -mv.z));
          vAlpha = smoothstep(260.0, 20.0, -mv.z) * (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 1.7 + aPhase)));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d));
          gl_FragColor = vec4(uColor, a * vAlpha * 0.4);
        }
      `,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.group.add(this.points);
  }

  update(dt, time, plane) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
    this.group.position.copy(plane.position);
  }
}

const windStreaks = new WindStreaks(scene);
const motes = new GoldenMotes(scene, isCoarse ? 130 : 240);

/* ————— UI ————— */

const ui = {
  score: document.getElementById("score"),
  rings: document.getElementById("rings"),
  combo: document.getElementById("combo"),
  comboStat: document.getElementById("combo-stat"),
  altitude: document.getElementById("altitude"),
  speed: document.getElementById("speed"),
  speedFill: document.getElementById("speed-fill"),
  target: document.getElementById("target"),
  targetDistance: document.getElementById("target-distance"),
  objective: document.getElementById("objective"),
  objectiveText: document.getElementById("objective-text"),
  toast: document.getElementById("toast"),
  toastTitle: document.getElementById("toast-title"),
  toastPoints: document.getElementById("toast-points"),
  controlHint: document.querySelector(".flight-hud"),
  hintText: document.getElementById("hint-text"),
  hotkeys: document.getElementById("hotkeys"),
  intro: document.getElementById("intro"),
  start: document.getElementById("start"),
  mute: document.getElementById("mute"),
  fullscreen: document.getElementById("fullscreen"),
  introFullscreen: document.getElementById("fullscreen-intro"),
  pause: document.getElementById("pause"),
  autoBtn: document.getElementById("autofly"),
  resume: document.getElementById("resume"),
  pauseMenu: document.getElementById("pause-menu"),
  fade: document.getElementById("fade"),
};

/* ————— Day / night cycle ————— */

const DAY_CYCLE_SECONDS = 180;
const DAY_CYCLE_START = 0.47;

// The cycle starts in the familiar golden hour, then rolls through dusk,
// night, dawn, and a clear high-sun day before returning to gold.
const DAY_KEYS = [
  {
    at: 0.0,
    label: "Dawn",
    skyTop: 0x293c6b,
    skyUpper: 0x7b6a9c,
    skyHorizon: 0xf0a58f,
    skyBottom: 0x3b3157,
    skySun: 0xffc08a,
    night: 0.15,
    fog: 0xc78f86,
    fogDensity: 0.00048,
    hemiSky: 0xb9c7e6,
    hemiGround: 0x4b4166,
    hemiIntensity: 0.55,
    sunLight: 0xffc89a,
    sunIntensity: 0.9,
    moonLight: 0xa9b8e8,
    moonIntensity: 0.08,
    fillColor: 0x8896d8,
    fillIntensity: 0.35,
    bounceColor: 0xd08a78,
    bounceIntensity: 0.25,
    skyFillColor: 0xffb07c,
    skyFillIntensity: 0.2,
    cloudFog: 0xd59b91,
    cloudSun: 0xffc49a,
    seaFog: 0xcf9289,
    seaDeep: 0x3b3560,
    seaLit: 0xf5b89b,
    seaRose: 0x9d6f82,
    waterfallFog: 0xd59b91,
    exposure: 0.86,
    bloomStrength: 0.28,
  },
  {
    at: 0.25,
    label: "Daylight",
    skyTop: 0x4a7bb5,
    skyUpper: 0x7fa7c9,
    skyHorizon: 0xf2d8b2,
    skyBottom: 0x6b7c9e,
    skySun: 0xfff4d4,
    night: 0,
    fog: 0xc7c7b5,
    fogDensity: 0.00034,
    hemiSky: 0xcfe4ff,
    hemiGround: 0x6e7a88,
    hemiIntensity: 0.95,
    sunLight: 0xfff1d0,
    sunIntensity: 1.75,
    moonLight: 0xa9b8e8,
    moonIntensity: 0,
    fillColor: 0x9fb8e8,
    fillIntensity: 0.45,
    bounceColor: 0xd6c0a0,
    bounceIntensity: 0.3,
    skyFillColor: 0xffe2b0,
    skyFillIntensity: 0.28,
    cloudFog: 0xd9d6c5,
    cloudSun: 0xfff1cf,
    seaFog: 0xd8d2bd,
    seaDeep: 0x6b7d9a,
    seaLit: 0xf6e3bf,
    seaRose: 0xb39a9e,
    waterfallFog: 0xd8d2bd,
    exposure: 0.85,
    bloomStrength: 0.25,
  },
  {
    at: 0.47,
    label: "Golden hour",
    skyTop: 0x39447e,
    skyUpper: 0x815a91,
    skyHorizon: 0xf2956c,
    skyBottom: 0x3b3057,
    skySun: 0xffcf8a,
    night: 0,
    fog: 0xdc9070,
    fogDensity: 0.00042,
    hemiSky: 0xffd4ad,
    hemiGround: 0x5d4b78,
    hemiIntensity: 0.78,
    sunLight: 0xffd49c,
    sunIntensity: 1.5,
    moonLight: 0x9fb1e0,
    moonIntensity: 0,
    fillColor: 0x94a0e8,
    fillIntensity: 0.4,
    bounceColor: 0xffa878,
    bounceIntensity: 0.38,
    skyFillColor: 0xffab7c,
    skyFillIntensity: 0.32,
    cloudFog: 0xf2b296,
    cloudSun: 0xffd3a2,
    seaFog: 0xe9a488,
    seaDeep: 0x4a3866,
    seaLit: 0xffd2a0,
    seaRose: 0xbf737d,
    waterfallFog: 0xf0ad90,
    exposure: 0.82,
    bloomStrength: 0.32,
  },
  {
    at: 0.58,
    label: "Dusk",
    skyTop: 0x2b2f63,
    skyUpper: 0x6a477f,
    skyHorizon: 0xe67f68,
    skyBottom: 0x2f2749,
    skySun: 0xffa76c,
    night: 0.2,
    fog: 0xb9746d,
    fogDensity: 0.0005,
    hemiSky: 0xd7a9b8,
    hemiGround: 0x44375d,
    hemiIntensity: 0.55,
    sunLight: 0xff9d6e,
    sunIntensity: 0.75,
    moonLight: 0x9fb1e0,
    moonIntensity: 0.35,
    fillColor: 0x7d85c8,
    fillIntensity: 0.35,
    bounceColor: 0xd47b6f,
    bounceIntensity: 0.25,
    skyFillColor: 0xff8f62,
    skyFillIntensity: 0.2,
    cloudFog: 0xd18b86,
    cloudSun: 0xffa978,
    seaFog: 0xc57d80,
    seaDeep: 0x352a50,
    seaLit: 0xe89b82,
    seaRose: 0x8f5f78,
    waterfallFog: 0xd18b86,
    exposure: 0.84,
    bloomStrength: 0.34,
  },
  {
    at: 0.72,
    label: "Nightfall",
    skyTop: 0x111a3c,
    skyUpper: 0x2c2a58,
    skyHorizon: 0x584566,
    skyBottom: 0x17152c,
    skySun: 0x9a8fc0,
    night: 0.75,
    fog: 0x4f4568,
    fogDensity: 0.00055,
    hemiSky: 0x6c7fb2,
    hemiGround: 0x241f38,
    hemiIntensity: 0.32,
    sunLight: 0x6f86b8,
    sunIntensity: 0.12,
    moonLight: 0xa8bdf0,
    moonIntensity: 0.5,
    fillColor: 0x5d6ea8,
    fillIntensity: 0.28,
    bounceColor: 0x5e4c78,
    bounceIntensity: 0.12,
    skyFillColor: 0x7a88bf,
    skyFillIntensity: 0.08,
    cloudFog: 0x4a4666,
    cloudSun: 0x9a93c0,
    seaFog: 0x4a4466,
    seaDeep: 0x15152c,
    seaLit: 0x6c6b96,
    seaRose: 0x3d3558,
    waterfallFog: 0x4a4666,
    exposure: 0.8,
    bloomStrength: 0.38,
  },
  {
    at: 0.82,
    label: "Deep night",
    skyTop: 0x070d24,
    skyUpper: 0x121a3d,
    skyHorizon: 0x2d2a50,
    skyBottom: 0x0b0c1c,
    skySun: 0x6f7cae,
    night: 1,
    fog: 0x252946,
    fogDensity: 0.0006,
    hemiSky: 0x445a92,
    hemiGround: 0x141324,
    hemiIntensity: 0.24,
    sunLight: 0x5066a0,
    sunIntensity: 0,
    moonLight: 0xa9c2ff,
    moonIntensity: 0.55,
    fillColor: 0x455a92,
    fillIntensity: 0.22,
    bounceColor: 0x3a3152,
    bounceIntensity: 0.06,
    skyFillColor: 0x4b5c93,
    skyFillIntensity: 0.04,
    cloudFog: 0x2b3050,
    cloudSun: 0x7e8bbd,
    seaFog: 0x2a2e4d,
    seaDeep: 0x0b0d20,
    seaLit: 0x3c4469,
    seaRose: 0x252342,
    waterfallFog: 0x2a2e4d,
    exposure: 0.78,
    bloomStrength: 0.42,
  },
  {
    at: 0.92,
    label: "Before dawn",
    skyTop: 0x17234a,
    skyUpper: 0x3c3c6e,
    skyHorizon: 0x8d6276,
    skyBottom: 0x1b1830,
    skySun: 0xc08ba0,
    night: 0.65,
    fog: 0x5a4d68,
    fogDensity: 0.00055,
    hemiSky: 0x7b86b0,
    hemiGround: 0x2b2540,
    hemiIntensity: 0.32,
    sunLight: 0xb08aa4,
    sunIntensity: 0.25,
    moonLight: 0x9fb5e8,
    moonIntensity: 0.3,
    fillColor: 0x6c7ab0,
    fillIntensity: 0.25,
    bounceColor: 0x6b4f64,
    bounceIntensity: 0.12,
    skyFillColor: 0xa77f95,
    skyFillIntensity: 0.08,
    cloudFog: 0x5b516c,
    cloudSun: 0xc29aa8,
    seaFog: 0x554c6c,
    seaDeep: 0x1b1b3a,
    seaLit: 0x7a6580,
    seaRose: 0x4a3a56,
    waterfallFog: 0x5b516c,
    exposure: 0.82,
    bloomStrength: 0.34,
  },
];

const daylight = {
  sunDirection: new THREE.Vector3(),
  moonDirection: new THREE.Vector3(),
  night: 0,
  label: "Golden hour",
  skyTop: new THREE.Color(),
  skyUpper: new THREE.Color(),
  skyHorizon: new THREE.Color(),
  skyBottom: new THREE.Color(),
  skySun: new THREE.Color(),
  fog: new THREE.Color(),
  fogDensity: 0.00042,
  hemiSky: new THREE.Color(),
  hemiGround: new THREE.Color(),
  hemiIntensity: 0.78,
  sunLight: new THREE.Color(),
  sunIntensity: 1.5,
  moonLight: new THREE.Color(),
  moonIntensity: 0,
  fillColor: new THREE.Color(),
  fillIntensity: 0.4,
  bounceColor: new THREE.Color(),
  bounceIntensity: 0.38,
  skyFillColor: new THREE.Color(),
  skyFillIntensity: 0.32,
  cloudFog: new THREE.Color(),
  cloudSun: new THREE.Color(),
  seaFog: new THREE.Color(),
  seaDeep: new THREE.Color(),
  seaLit: new THREE.Color(),
  seaRose: new THREE.Color(),
  waterfallFog: new THREE.Color(),
  exposure: 0.82,
  bloomStrength: 0.32,
};

const keyColor = new THREE.Color();
function mixKeyColor(target, a, b, t) {
  target.setHex(a).lerp(keyColor.setHex(b), t);
}

function sampleDaylight(cycle) {
  let a = DAY_KEYS[DAY_KEYS.length - 1];
  let b = DAY_KEYS[0];
  let span = 1;
  let local = 0;
  for (let i = 0; i < DAY_KEYS.length; i++) {
    const key = DAY_KEYS[i];
    const next = DAY_KEYS[(i + 1) % DAY_KEYS.length];
    const end = i === DAY_KEYS.length - 1 ? 1 : next.at;
    if (cycle >= key.at && cycle < end) {
      a = key;
      b = next;
      span = Math.max(0.0001, end - key.at);
      local = (cycle - key.at) / span;
      break;
    }
  }
  if (cycle >= DAY_KEYS[DAY_KEYS.length - 1].at) {
    a = DAY_KEYS[DAY_KEYS.length - 1];
    b = DAY_KEYS[0];
    span = Math.max(0.0001, 1 - a.at);
    local = (cycle - a.at) / span;
  }
  const t = easeInOutCubic(clamp(local, 0, 1));
  mixKeyColor(daylight.skyTop, a.skyTop, b.skyTop, t);
  mixKeyColor(daylight.skyUpper, a.skyUpper, b.skyUpper, t);
  mixKeyColor(daylight.skyHorizon, a.skyHorizon, b.skyHorizon, t);
  mixKeyColor(daylight.skyBottom, a.skyBottom, b.skyBottom, t);
  mixKeyColor(daylight.skySun, a.skySun, b.skySun, t);
  mixKeyColor(daylight.fog, a.fog, b.fog, t);
  mixKeyColor(daylight.hemiSky, a.hemiSky, b.hemiSky, t);
  mixKeyColor(daylight.hemiGround, a.hemiGround, b.hemiGround, t);
  mixKeyColor(daylight.sunLight, a.sunLight, b.sunLight, t);
  mixKeyColor(daylight.moonLight, a.moonLight, b.moonLight, t);
  mixKeyColor(daylight.fillColor, a.fillColor, b.fillColor, t);
  mixKeyColor(daylight.bounceColor, a.bounceColor, b.bounceColor, t);
  mixKeyColor(daylight.skyFillColor, a.skyFillColor, b.skyFillColor, t);
  mixKeyColor(daylight.cloudFog, a.cloudFog, b.cloudFog, t);
  mixKeyColor(daylight.cloudSun, a.cloudSun, b.cloudSun, t);
  mixKeyColor(daylight.seaFog, a.seaFog, b.seaFog, t);
  mixKeyColor(daylight.seaDeep, a.seaDeep, b.seaDeep, t);
  mixKeyColor(daylight.seaLit, a.seaLit, b.seaLit, t);
  mixKeyColor(daylight.seaRose, a.seaRose, b.seaRose, t);
  mixKeyColor(daylight.waterfallFog, a.waterfallFog, b.waterfallFog, t);
  daylight.night = lerp(a.night, b.night, t);
  daylight.fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  daylight.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
  daylight.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  daylight.moonIntensity = lerp(a.moonIntensity, b.moonIntensity, t);
  daylight.fillIntensity = lerp(a.fillIntensity, b.fillIntensity, t);
  daylight.bounceIntensity = lerp(a.bounceIntensity, b.bounceIntensity, t);
  daylight.skyFillIntensity = lerp(a.skyFillIntensity, b.skyFillIntensity, t);
  daylight.exposure = lerp(a.exposure, b.exposure, t);
  daylight.bloomStrength = lerp(a.bloomStrength, b.bloomStrength, t);
  daylight.label = t < 0.5 ? a.label : b.label;
}

/* ————— Game state ————— */

const state = {
  mode: "intro",
  elapsed: 0,
  introTime: 0,
  paused: false,
  started: false,
  score: 0,
  displayScore: 0,
  ringCount: 0,
  combo: 1,
  cameraShake: 0,
  bumpFlash: 0,
  hintTimer: 0,
  objectiveTimer: 0,
  toastTimer: null,
  targetVisible: false,
  introCameraTime: null,
  freezeIntro: false,
  autoFly: false,
  autoByIdle: false,
  idleTime: 0,
  idleDelay: 10,
  cameraPreset: null,
  cameraClose: false,
  cameraCinematic: false,
  cinematicTime: 0,
  cinematicBlend: 0,
  dayCycle: DAY_CYCLE_START,
  dayPhase: "Golden hour",
  dayNight: 0,
};

const input = {
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  boost: false,
  hasInput: false,
  touch: false,
  grace: 0,
  touchStart: { x: 0, y: 0 },
};

const keys = Object.create(null);
const prevPosition = new THREE.Vector3();
const chaseOffset = new THREE.Vector3(0, 4.4, 13.2);
const chaseLook = new THREE.Vector3();
const cameraLook = new THREE.Vector3(0, 42, 0);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const autoTarget = new THREE.Vector3();
const autoSide = new THREE.Vector3();
const autoApproach = new THREE.Vector3();
const autoExit = new THREE.Vector3();
const planeQuat = new THREE.Quaternion();

// Auto-flight camera rig. Four angles, each with a long-shot and close-up
// distance. Re-pressing the active angle key toggles the distance.
const CHASE_BASE_PITCH = Math.atan2(4.4, 13.2);
const CHASE_BASE_DISTANCE = Math.hypot(4.4, 13.2);
const CHASE_CLOSE_DISTANCE = 15.4; // the previous long-shot distance
const CHASE_LONG_DISTANCE = CHASE_CLOSE_DISTANCE * 2;
const CAMERA_PRESETS = {
  KeyW: { name: "High", yaw: 0, pitch: 0.58 },
  KeyS: { name: "Low", yaw: 0, pitch: 0.17 },
  KeyA: { name: "Left", yaw: -0.72, pitch: 0.3 },
  KeyD: { name: "Right", yaw: 0.72, pitch: 0.3 },
};
const cameraRig = {
  yaw: 0,
  pitch: CHASE_BASE_PITCH,
  distance: CHASE_BASE_DISTANCE,
};
const CAMERA_TRANSITION_DURATION = 1.35;
// A long, undisturbed auto-flight eventually hands the camera to a slow
// pan-and-tilt operator. The two frequencies keep the sweep from feeling
// mechanical while still following the plane.
const CINEMATIC_IDLE_TIME = 60;
const CINEMATIC_BLEND_RATE = 1.25;
const CINEMATIC_PAN_SPEED = 0.075;
const CINEMATIC_PAN_DRIFT_SPEED = 0.031;
const CINEMATIC_PAN_AMPLITUDE = 0.62;
const CINEMATIC_PAN_DRIFT = 0.16;
const CINEMATIC_TILT_SPEED = 0.057;
const CINEMATIC_TILT_DRIFT_SPEED = 0.023;
const CINEMATIC_TILT_AMPLITUDE = 0.2;
const CINEMATIC_TILT_DRIFT = 0.07;
const cameraTween = {
  fromYaw: 0,
  fromPitch: CHASE_BASE_PITCH,
  fromDistance: CHASE_BASE_DISTANCE,
  toYaw: 0,
  toPitch: CHASE_BASE_PITCH,
  toDistance: CHASE_BASE_DISTANCE,
  elapsed: CAMERA_TRANSITION_DURATION,
};
let cameraStatusTimer = null;

const introShots = [
  // Opening frame: over the shoulder, first ring dead ahead, hero island to the left.
  { pos: new THREE.Vector3(1.8, 2.2, 9.2), look: new THREE.Vector3(0, 5.0, -50) },
  // High wide reveal of the drifting archipelago.
  { pos: new THREE.Vector3(46, 26, 30), look: new THREE.Vector3(0, -8, -46) },
  // Elevated side tracker: island silhouettes against the sun.
  { pos: new THREE.Vector3(-15, 5, 7), look: new THREE.Vector3(0, 0, -10) },
  // High behind, gliding down over the islands.
  { pos: new THREE.Vector3(10, 15, 20), look: new THREE.Vector3(0, -5, -46) },
  // Close hero chase through a golden ring.
  { pos: new THREE.Vector3(6.5, 3.0, 9.5), look: new THREE.Vector3(0, 1.4, -16) },
];

function shapeInput(value) {
  const dead = 0.055;
  const s = Math.sign(value) * Math.max(0, (Math.abs(value) - dead) / (1 - dead));
  return clamp(s * 1.18, -1, 1);
}

function updateInputFromPointer(clientX, clientY, type) {
  if (state.mode !== "playing" || state.paused || input.grace > 0) return;
  if (type === "touch") {
    const dx = clientX - input.touchStart.x;
    const dy = clientY - input.touchStart.y;
    const scale = Math.min(window.innerWidth, window.innerHeight) * 0.4;
    input.targetX = shapeInput(dx / scale);
    input.targetY = shapeInput(-dy / scale);
  } else {
    const nx = (clientX / window.innerWidth) * 2 - 1;
    const ny = -((clientY / window.innerHeight) * 2 - 1);
    input.targetX = shapeInput(nx * 1.08);
    input.targetY = shapeInput(ny * 1.02);
  }
  input.hasInput = true;
}

let lastPointerX = null;
let lastPointerY = null;

window.addEventListener("pointermove", (e) => {
  const moved =
    lastPointerX === null ||
    (e.clientX - lastPointerX) ** 2 + (e.clientY - lastPointerY) ** 2 > 4;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  if (moved) noteManualActivity(false);
  updateInputFromPointer(e.clientX, e.clientY, e.pointerType === "touch" ? "touch" : "mouse");
});

window.addEventListener("pointerdown", (e) => {
  if (state.mode !== "playing" || state.paused) return;
  // HUD controls are not steering: let the auto-flight switch be clicked cleanly.
  if (e.target instanceof Element && e.target.closest("button")) return;
  noteManualActivity(true);
  if (e.pointerType === "touch") {
    input.touch = true;
    input.touchStart.x = e.clientX;
    input.touchStart.y = e.clientY;
    input.targetX = 0;
    input.targetY = 0;
  } else {
    updateInputFromPointer(e.clientX, e.clientY, "mouse");
  }
});

window.addEventListener("pointerup", () => {
  input.touch = false;
});

window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  const autoCameraKey =
    state.autoFly &&
    state.mode === "playing" &&
    !state.paused &&
    CAMERA_PRESETS[e.code];
  const boostKey = e.code === "ShiftLeft" || e.code === "ShiftRight";
  if (AUTO_KEYS.has(e.code) && state.mode === "playing" && !state.paused) {
    // Shift is a boost modifier, not a takeover: it never cancels auto-flight.
    if (autoCameraKey || boostKey) noteManualActivity(false);
    else noteManualActivity(true);
  }
  if (autoCameraKey) {
    e.preventDefault();
    if (!e.repeat) cycleAutoCamera(e.code);
  }
  if (e.code === "Space" && !state.started) {
    e.preventDefault();
    startGame();
  } else if (e.code === "Space") {
    e.preventDefault();
  }
  const planeChoice =
    e.code === "Digit1" || e.code === "Numpad1"
      ? 1
      : e.code === "Digit2" || e.code === "Numpad2"
        ? 2
        : e.code === "Digit3" || e.code === "Numpad3"
          ? 3
          : 0;
  if (planeChoice) {
    e.preventDefault();
    if (!e.repeat) setPlaneStyle(planeChoice);
  }
  if (e.code === "KeyF" && state.mode === "playing" && !state.paused) {
    e.preventDefault();
    state.idleTime = 0;
    setAutoFly(!state.autoFly, "manual");
  }
  if ((e.code === "BracketLeft" || e.code === "BracketRight") && state.mode === "playing" && !state.paused) {
    e.preventDefault();
    changeIdleDelay(e.code === "BracketLeft" ? -AUTO_IDLE_STEP : AUTO_IDLE_STEP);
  }
  if (e.code === "KeyH" && state.mode === "playing" && !state.paused) {
    e.preventDefault();
    if (!e.repeat) showHotkeys();
  }
  if (e.code === "KeyM" && state.mode === "playing") {
    e.preventDefault();
    if (!e.repeat) toggleMute();
  }
  if ((e.code === "Escape" || e.code === "KeyP") && state.mode === "playing") {
    togglePause();
  }
});

window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

function readInput(dt) {
  let kx = 0;
  let ky = 0;
  if (keys["KeyA"] || keys["ArrowLeft"]) kx -= 1;
  if (keys["KeyD"] || keys["ArrowRight"]) kx += 1;
  if (keys["KeyW"] || keys["ArrowUp"]) ky += 1;
  if (keys["KeyS"] || keys["ArrowDown"]) ky -= 1;
  const boost = !!(keys["ShiftLeft"] || keys["ShiftRight"]);

  const targetX = clamp(input.targetX + kx, -1.2, 1.2);
  const targetY = clamp(input.targetY + ky, -1.2, 1.2);
  input.x = damp(input.x, targetX, 7.5, dt);
  input.y = damp(input.y, targetY, 7.5, dt);
  input.boost = boost;
  input.hasInput = input.hasInput || Math.abs(kx) > 0 || Math.abs(ky) > 0;
  return input;
}

/* ————— UI helpers ————— */

function setBodyClass(name, on) {
  document.body.classList.toggle(name, on);
}

const HOTKEYS_VISIBLE_MS = 5000;
let hotkeysTimer = 0;

function showHotkeys() {
  if (!ui.hotkeys) return;
  ui.hotkeys.classList.add("show");
  ui.hotkeys.setAttribute("aria-hidden", "false");
  clearTimeout(hotkeysTimer);
  hotkeysTimer = setTimeout(() => {
    ui.hotkeys.classList.remove("show");
    ui.hotkeys.setAttribute("aria-hidden", "true");
  }, HOTKEYS_VISIBLE_MS);
}

function showToast(title, points = "") {
  ui.toastTitle.textContent = title;
  ui.toastPoints.textContent = points;
  ui.toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1150);
}

function bumpCombo() {
  ui.comboStat.classList.remove("bump");
  void ui.comboStat.offsetWidth;
  ui.comboStat.classList.add("bump");
  setTimeout(() => ui.comboStat.classList.remove("bump"), 420);
}

function addRingScore(ring) {
  const accuracy = ring.accuracy ?? 0.5;
  plane.pulseGlow();
  state.combo += 1;
  const points = Math.round((100 + accuracy * 60) * state.combo);
  state.score += points;
  state.ringCount++;
  ui.rings.textContent = String(state.ringCount);
  ui.combo.textContent = `×${state.combo}`;
  ui.comboStat.classList.add("active");
  bumpCombo();
  let title = "Through";
  if (accuracy > 0.82) title = "Perfect";
  else if (accuracy > 0.55) title = "Beautiful";
  showToast(title, `+${points}`);
  sound.ringChime(state.combo);
  state.cameraShake = Math.min(state.cameraShake + 0.18, 0.5);
}

function missRing() {
  if (state.combo > 1) {
    showToast("Drifted", "");
    state.combo = 1;
    ui.combo.textContent = "×1";
    ui.comboStat.classList.remove("active");
    sound.miss();
  }
}

/* ————— Auto-flight ————— */

const AUTO_IDLE_MIN = 10;
const AUTO_IDLE_MAX = 30;
const AUTO_IDLE_STEP = 5;
const AUTO_IDLE_STORE = "sky.autoIdle";
const AUTO_KEYS = new Set([
  "KeyA",
  "KeyD",
  "KeyW",
  "KeyS",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "ShiftLeft",
  "ShiftRight",
  "Space",
]);

// Auto-flight can decline the hoop immediately ahead when threading it would
// force a hard turn toward the following hoop. The rest of the route stays.
const AUTO_SKIP_TURN = 0.9; // radians
const AUTO_SKIP_DISTANCE = 140;
const AUTO_FLOURISH_OFFSET = 4.2;
const AUTO_FLOURISH_BANK = 0.08;

function maybeSkipSharpAutoHoop() {
  if (state.mode !== "playing") return;
  const first = world.nextRingAhead(plane.position);
  if (!first) return;
  if (first.distance - world.currentProgress > AUTO_SKIP_DISTANCE) return;

  const second = world.nextRingAfter(first);
  if (!second) return;

  autoApproach.set(
    first.center.x - plane.position.x,
    0,
    first.center.z - plane.position.z
  );
  autoExit.set(
    second.center.x - first.center.x,
    0,
    second.center.z - first.center.z
  );
  const approachLength = autoApproach.length();
  const exitLength = autoExit.length();
  if (approachLength < 2 || exitLength < 2) return;

  const turn = Math.acos(
    clamp(autoApproach.dot(autoExit) / (approachLength * exitLength), -1, 1)
  );
  if (turn >= AUTO_SKIP_TURN) world.skipRing(first);
}

function loadIdleDelay() {
  try {
    const stored = Number(localStorage.getItem(AUTO_IDLE_STORE));
    if (Number.isFinite(stored) && stored > 0) {
      return clamp(
        Math.round(stored / AUTO_IDLE_STEP) * AUTO_IDLE_STEP,
        AUTO_IDLE_MIN,
        AUTO_IDLE_MAX
      );
    }
  } catch (error) {
    // Storage can be unavailable; fall back to the default.
  }
  return AUTO_IDLE_MIN;
}

function setIdleDelay(value, announce = true) {
  const next = clamp(
    Math.round(value / AUTO_IDLE_STEP) * AUTO_IDLE_STEP,
    AUTO_IDLE_MIN,
    AUTO_IDLE_MAX
  );
  state.idleDelay = next;
  if (ui.autoBtn) {
    ui.autoBtn.title = `Auto-flight (F) · WASD camera in auto · idle after ${next}s · [ and ] to adjust`;
  }
  try {
    localStorage.setItem(AUTO_IDLE_STORE, String(next));
  } catch (error) {
    // Ignore storage failures; the setting still applies this session.
  }
  if (announce) {
    showToast("Auto-flight waits", `${next}s`);
    sound.softClick();
  }
}

function changeIdleDelay(delta) {
  state.idleTime = 0;
  setIdleDelay(state.idleDelay + delta, true);
}

/* ————— Paper-plane style choice ————— */

const PLANE_STYLE_STORE = "sky.planeStyle";
const PLANE_NAMES = {
  1: "classic dart",
  2: "photo dart",
  3: "paper crane",
};

function loadPlaneStyle() {
  try {
    const stored = Number(localStorage.getItem(PLANE_STYLE_STORE));
    if (stored === 1 || stored === 2 || stored === 3) return stored;
  } catch (error) {
    // Storage can be unavailable; fall back to the classic dart.
  }
  return 1;
}

function setPlaneStyle(style, announce = true) {
  const next = style === 2 || style === 3 ? style : 1;
  plane.setModelStyle(next);
  try {
    localStorage.setItem(PLANE_STYLE_STORE, String(next));
  } catch (error) {
    // Ignore storage failures; the choice still applies this session.
  }
  if (announce) {
    showToast(`Paper plane ${next}`, PLANE_NAMES[next]);
    sound.softClick();
  }
}

plane.setModelStyle(loadPlaneStyle(), true);

const HINT_MANUAL = `<b>Move</b> to steer &nbsp;·&nbsp; <b>Hold Shift</b> to soar &nbsp;·&nbsp; <b>1 2 3</b> plane &nbsp;·&nbsp; <b>F</b> auto &nbsp;·&nbsp; <b>H</b> help`;
const HINT_AUTO = `<b>WASD</b> camera &nbsp;·&nbsp; <b>same key</b> close/long &nbsp;·&nbsp; <b>F</b> manual &nbsp;·&nbsp; <b>H</b> help`;

function setAutoFly(on, origin = "manual") {
  const next = !!on;
  if (state.autoFly === next) return;
  state.autoFly = next;
  state.autoByIdle = next && origin === "idle";
  setBodyClass("auto-fly", next);
  if (ui.autoBtn) {
    ui.autoBtn.classList.toggle("active", next);
    ui.autoBtn.setAttribute("aria-pressed", String(next));
  }
  if (next) {
    // Let go of the controls cleanly so the pursuit starts from neutral.
    input.hasInput = false;
    input.targetX = 0;
    input.targetY = 0;
    input.x = 0;
    input.y = 0;
    maybeSkipSharpAutoHoop();
    showToast("Auto-flight", "hands off");
  } else {
    // Hand back a neutral stick; the next pointer move takes over.
    input.hasInput = false;
    input.targetX = 0;
    input.targetY = 0;
    input.x = 0;
    input.y = 0;
    state.cameraPreset = null;
    state.cameraClose = false;
    state.cameraCinematic = false;
    showToast("You have the wind", "");
  }
  ui.objectiveText.textContent = next
    ? "Auto-flight engaged · hands off"
    : "Follow the golden rings";
  ui.objective.classList.remove("dim");
  state.objectiveTimer = 0;
  if (ui.hintText) ui.hintText.innerHTML = next ? HINT_AUTO : HINT_MANUAL;
  ui.controlHint.classList.remove("hide-hint");
  state.hintTimer = 0;
  clearTimeout(cameraStatusTimer);
  sound.softClick();
}

/**
 * Mark deliberate pilot activity. Mouse movement only resets the idle timer;
 * a real click or key press also hands control back if auto began from idling.
 * While the long-idle cinematic follow is active, only disengaging auto-flight
 * (or explicitly choosing a camera preset) hands the camera back.
 */
function noteManualActivity(cancelIdleAuto = true) {
  state.idleTime = 0;
  if (cancelIdleAuto && state.autoByIdle && !state.cameraCinematic) {
    setAutoFly(false, "input");
  }
}

/* ————— Start & pause ————— */

async function startGame() {
  if (state.started) return;
  state.started = true;
  setBodyClass("starting", true);
  sound.start();
  sound.softClick();
  setTimeout(() => setBodyClass("starting", false), 500);

  // Align the plane with its current cinematic heading.
  plane.resetAt(plane.position, plane.direction, 33);
  input.x = 0;
  input.y = 0;
  input.targetX = 0;
  input.targetY = 0;
  input.hasInput = false;
  input.grace = 0.9;
  const currentD = -plane.position.z;
  for (const ring of world.rings) {
    if (ring.distance < currentD - 6 && ring.state === "active") ring.state = "passed";
  }

  world.ensureAhead(plane.position);
  const next = world.nextRing(plane.position);
  world.setHighlight(next);
  state.mode = "playing";
  state.hintTimer = 0;
  state.objectiveTimer = 0;
  state.idleTime = 0;
  state.cameraCinematic = false;
  state.cinematicTime = 0;
  state.cinematicBlend = 0;
  setBodyClass("playing", true);
  setBodyClass("paused", false);
  ui.objectiveText.textContent = "Follow the golden rings";
}

function togglePause(force) {
  if (state.mode !== "playing") return;
  state.paused = force ?? !state.paused;
  setBodyClass("paused", state.paused);
  sound.setPaused(state.paused);
  if (!state.paused) {
    input.targetX = 0;
    input.targetY = 0;
    sound.softClick();
  }
}

ui.start.addEventListener("click", () => startGame());
ui.resume.addEventListener("click", () => togglePause(false));

function syncMuteUI() {
  setBodyClass("muted", sound.muted);
  ui.mute.setAttribute("aria-pressed", String(sound.muted));
  ui.mute.setAttribute("aria-label", sound.muted ? "Unmute sound" : "Mute sound");
  ui.mute.title = sound.muted ? "Unmute sound (M)" : "Mute sound (M)";
}

function toggleMute() {
  sound.setMuted(!sound.muted);
  syncMuteUI();
  if (!sound.muted) sound.softClick();
}

ui.mute.addEventListener("click", toggleMute);
syncMuteUI();

function requestFullscreen() {
  const request =
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen;
  return request.call(document.documentElement);
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  return exit.call(document);
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

const fullscreenSupported =
  document.fullscreenEnabled !== false &&
  (typeof document.documentElement.requestFullscreen === "function" ||
    typeof document.documentElement.webkitRequestFullscreen === "function") &&
  (typeof document.exitFullscreen === "function" ||
    typeof document.webkitExitFullscreen === "function");
const fullscreenButtons = [ui.fullscreen, ui.introFullscreen].filter(Boolean);

function syncFullscreenUI() {
  if (!fullscreenButtons.length) return;
  const active = !!getFullscreenElement();
  setBodyClass("fullscreen", active);
  const label = active ? "Exit full screen" : "Enter full screen";
  for (const button of fullscreenButtons) {
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  requestAnimationFrame(resize);
}

async function toggleFullscreen() {
  if (!fullscreenSupported) return;
  try {
    if (getFullscreenElement()) {
      await exitFullscreen();
    } else {
      await requestFullscreen();
    }
  } catch (error) {
    // The browser may reject the request when it is not allowed; keep the
    // button state in sync with whatever actually happened.
  }
  syncFullscreenUI();
}

if (fullscreenButtons.length) {
  if (fullscreenSupported) {
    for (const button of fullscreenButtons) {
      button.addEventListener("click", toggleFullscreen);
    }
    for (const eventName of ["fullscreenchange", "webkitfullscreenchange"]) {
      document.addEventListener(eventName, syncFullscreenUI);
    }
    for (const eventName of ["fullscreenerror", "webkitfullscreenerror"]) {
      document.addEventListener(eventName, syncFullscreenUI);
    }
    syncFullscreenUI();
  } else {
    for (const button of fullscreenButtons) {
      button.hidden = true;
    }
  }
}

ui.pause.addEventListener("click", () => togglePause(true));

if (ui.autoBtn) {
  ui.autoBtn.addEventListener("click", () => {
    state.idleTime = 0;
    setAutoFly(!state.autoFly, "manual");
  });
}

// Restore the saved idle delay (10s by default) and paint it on the switch.
setIdleDelay(loadIdleDelay(), false);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.mode === "playing" && !state.paused) {
    togglePause(true);
  } else if (!document.hidden) {
    sound.resume();
  }
});

/* ————— Intro & chase cameras ————— */

function updateIntroCamera(dt, time) {
  const shot = introShots[Math.floor(time / 7.5) % introShots.length];
  plane.group.getWorldQuaternion(planeQuat);
  tmp.copy(shot.pos).applyQuaternion(planeQuat).add(plane.position);
  tmp2.copy(shot.look).applyQuaternion(planeQuat).add(plane.position);

  // Add a breath of handheld drift.
  tmp.x += Math.sin(time * 0.31) * 0.5;
  tmp.y += Math.cos(time * 0.24) * 0.4;

  const lambda = 1.5;
  camera.position.lerp(tmp, 1 - Math.exp(-lambda * dt));
  cameraLook.lerp(tmp2, 1 - Math.exp(-2.2 * dt));
  camera.lookAt(cameraLook);
  const fov = 52 + Math.sin(time * 0.13) * 1.5;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = damp(camera.fov, fov, 1.2, dt);
    camera.updateProjectionMatrix();
  }
}

function cycleAutoCamera(code) {
  if (!CAMERA_PRESETS[code]) return;
  // A deliberate camera choice leaves the long-idle cinematic follow.
  state.cameraCinematic = false;
  if (state.cameraPreset === code) {
    state.cameraClose = !state.cameraClose;
  } else {
    state.cameraPreset = code;
  }
  showCameraStatus();
  sound.softClick();
}

function showCameraStatus() {
  const preset = CAMERA_PRESETS[state.cameraPreset];
  if (!preset) return;
  ui.objectiveText.textContent = `Camera · ${preset.name} · ${
    state.cameraClose ? "Close-up" : "Long shot"
  }`;
  ui.objective.classList.remove("dim");
  state.objectiveTimer = 0;
  clearTimeout(cameraStatusTimer);
  cameraStatusTimer = setTimeout(() => {
    if (!state.autoFly) return;
    ui.objectiveText.textContent = "Auto-flight engaged · hands off";
    state.objectiveTimer = 0;
  }, 1600);
}

function updateChaseCamera(dt, time) {
  plane.group.getWorldQuaternion(planeQuat);

  const preset = state.autoFly ? CAMERA_PRESETS[state.cameraPreset] : null;
  const targetYaw = preset ? preset.yaw : 0;
  const targetPitch = preset ? preset.pitch : CHASE_BASE_PITCH;
  let targetDistance = CHASE_BASE_DISTANCE;
  if (preset) {
    targetDistance = state.cameraClose ? CHASE_CLOSE_DISTANCE : CHASE_LONG_DISTANCE;
  }

  // Ease in and out whenever the requested angle or distance changes.
  const targetChanged =
    Math.abs(targetYaw - cameraTween.toYaw) > 1e-4 ||
    Math.abs(targetPitch - cameraTween.toPitch) > 1e-4 ||
    Math.abs(targetDistance - cameraTween.toDistance) > 1e-4;
  if (targetChanged) {
    cameraTween.fromYaw = cameraRig.yaw;
    cameraTween.fromPitch = cameraRig.pitch;
    cameraTween.fromDistance = cameraRig.distance;
    cameraTween.toYaw = targetYaw;
    cameraTween.toPitch = targetPitch;
    cameraTween.toDistance = targetDistance;
    cameraTween.elapsed = 0;
  }

  if (cameraTween.elapsed < CAMERA_TRANSITION_DURATION) {
    cameraTween.elapsed = Math.min(
      cameraTween.elapsed + dt,
      CAMERA_TRANSITION_DURATION
    );
    const eased = easeInOutCubic(
      cameraTween.elapsed / CAMERA_TRANSITION_DURATION
    );
    cameraRig.yaw = lerp(cameraTween.fromYaw, cameraTween.toYaw, eased);
    cameraRig.pitch = lerp(cameraTween.fromPitch, cameraTween.toPitch, eased);
    cameraRig.distance = lerp(
      cameraTween.fromDistance,
      cameraTween.toDistance,
      eased
    );
  } else {
    cameraRig.yaw = cameraTween.toYaw;
    cameraRig.pitch = cameraTween.toPitch;
    cameraRig.distance = cameraTween.toDistance;
  }

  // Layer the long-idle cinematic pan and tilt on top of the settled chase
  // angle. The blend makes both the takeover and the hand-back gradual.
  state.cinematicBlend = damp(
    state.cinematicBlend,
    state.cameraCinematic ? 1 : 0,
    CINEMATIC_BLEND_RATE,
    dt
  );
  const cinematic = state.cinematicBlend;
  let pan = 0;
  let tilt = 0;
  if (cinematic > 0.0001) {
    const t = state.cinematicTime;
    pan =
      (Math.sin(t * CINEMATIC_PAN_SPEED) * CINEMATIC_PAN_AMPLITUDE +
        Math.sin(t * CINEMATIC_PAN_DRIFT_SPEED + 1.3) * CINEMATIC_PAN_DRIFT) *
      cinematic;
    tilt =
      (Math.sin(t * CINEMATIC_TILT_SPEED + 0.8) * CINEMATIC_TILT_AMPLITUDE +
        Math.sin(t * CINEMATIC_TILT_DRIFT_SPEED) * CINEMATIC_TILT_DRIFT) *
      cinematic;
  }
  const finalYaw = cameraRig.yaw + pan;
  const finalPitch = clamp(cameraRig.pitch + tilt, 0.08, 0.95);
  const cosPitch = Math.cos(finalPitch);
  chaseOffset.set(
    Math.sin(finalYaw) * cosPitch * cameraRig.distance,
    Math.sin(finalPitch) * cameraRig.distance,
    Math.cos(finalYaw) * cosPitch * cameraRig.distance
  );

  tmp.copy(chaseOffset).applyQuaternion(planeQuat).add(plane.position);
  tmp.y += 0.6;

  const speedFactor = clamp((plane.speed - 26) / 34, 0, 1);
  const speedLift = speedFactor * 0.7;
  tmp.y += speedLift;
  tmp.z += speedFactor * 0.6;

  const shake = state.cameraShake;
  state.cameraShake = damp(state.cameraShake, 0, 3.5, dt);
  if (shake > 0.001) {
    tmp.x += (Math.random() - 0.5) * shake * 0.55;
    tmp.y += (Math.random() - 0.5) * shake * 0.5;
    tmp.z += (Math.random() - 0.5) * shake * 0.3;
  }

  const positionLambda = state.mode === "playing" ? 4.2 : 2.4;
  if (preset && !state.paused) {
    // Cancel the follow lag so a close-up actually stays close to the plane.
    tmp.addScaledVector(plane.direction, plane.speed / positionLambda);
  }
  camera.position.lerp(tmp, 1 - Math.exp(-positionLambda * dt));

  // Side views pull the look point back toward the plane so it stays framed;
  // close-ups shorten the lead so the plane fills more of the picture.
  const lookAhead =
    22 *
    (cameraRig.distance / CHASE_BASE_DISTANCE) *
    Math.pow(Math.max(0.25, Math.cos(finalYaw)), 1.35);
  tmp2.copy(plane.direction).multiplyScalar(lookAhead).add(plane.position);
  tmp2.y += 1.4 + plane.pitch * 3.5;
  cameraLook.lerp(tmp2, 1 - Math.exp(-5.5 * dt));

  // Slight sideways lean into the bank.
  cameraLook.x += plane.bank * 1.1 * (1 - Math.exp(-3 * dt));
  camera.lookAt(cameraLook);

  const targetFov = 60 + speedFactor * 9 + plane.boost * 5;
  camera.fov = damp(camera.fov, targetFov, 3.5, dt);
  // The cinematic head pans and tilts without inheriting quite so much of the
  // plane's bank roll.
  camera.rotation.z += -plane.bank * 0.045 * (1 - cinematic * 0.7);
  camera.updateProjectionMatrix();
}

/* ————— Ring target marker ————— */

function updateTargetMarker(next) {
  if (!next || next.state !== "active") {
    ui.target.classList.remove("visible");
    state.targetVisible = false;
    return;
  }
  const distance = plane.position.distanceTo(next.center);
  tmp.copy(next.center).project(camera);
  const behind = tmp.z > 1 || tmp.z < -1;
  let x = (tmp.x * 0.5 + 0.5) * window.innerWidth;
  let y = (-tmp.y * 0.5 + 0.5) * window.innerHeight;
  if (behind) {
    x = window.innerWidth - x;
    y = window.innerHeight - y;
  }
  const marginX = 80;
  const marginTop = 120;
  const marginBottom = 90;
  x = clamp(x, marginX, window.innerWidth - marginX);
  y = clamp(y, marginTop, window.innerHeight - marginBottom);
  ui.target.style.transform = `translate(${x}px, ${y}px)`;
  ui.targetDistance.textContent = `${Math.round(distance)} m`;
  if (!state.targetVisible) {
    ui.target.classList.add("visible");
    state.targetVisible = true;
  }
}

/* ————— Collision with the islands ————— */

function handleCollisions() {
  const correction = world.collide(plane.position);
  if (correction) {
    if (plane.bump(correction, 3.4)) {
      sound.bump();
      state.cameraShake = 0.9;
      state.bumpFlash = 1;
      state.combo = 1;
      ui.combo.textContent = "×1";
      ui.comboStat.classList.remove("active");
      showToast("Steady", "keep flying");
    }
  }

  // If the pilot wanders far off the course, the wind gently tugs them back.
  const courseAt = -plane.position.z;
  const pathPoint = coursePoint(courseAt, tmp);
  const lateral = Math.hypot(plane.position.x - pathPoint.x, 0);
  if (lateral > 720) {
    const pull = tmp2.set(pathPoint.x - plane.position.x, 0, 0).normalize();
    plane.position.addScaledVector(pull, (lateral - 720) * 0.9 * (1 / 60));
    plane.yaw += pull.x * 0.0012;
    if (Math.random() < 0.02) showToast("The wind turns you home", "");
  }
}

/* ————— Main loop ————— */

const clock = { last: performance.now() };
let elapsed = 0;
let firstFrame = true;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioLimit));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}

window.addEventListener("resize", resize);

function updateSun(focus) {
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDirection, 260);
  skyFill.position.copy(focus).addScaledVector(sunDirection, 220);
  moon.target.position.copy(focus);
  moon.position.copy(focus).addScaledVector(moonDirection, 260);
}

function updateDayCycle(dt) {
  state.dayCycle = (state.dayCycle + dt / DAY_CYCLE_SECONDS) % 1;
  sampleDaylight(state.dayCycle);

  // The sun tracks a slow east-to-west arc. At the golden-hour start it sits
  // almost exactly where the original fixed sunset light used to be.
  const sunHeight = Math.sin(state.dayCycle * TAU);
  const sunTheta = 0.395 + (state.dayCycle - 0.47) * TAU;
  const horizontal = Math.sqrt(Math.max(0, 1 - sunHeight * sunHeight));
  daylight.sunDirection
    .set(
      Math.sin(sunTheta) * horizontal,
      sunHeight,
      -Math.cos(sunTheta) * horizontal
    )
    .normalize();
  daylight.moonDirection.copy(daylight.sunDirection).multiplyScalar(-1);
  sunDirection.copy(daylight.sunDirection);
  moonDirection.copy(daylight.moonDirection);

  sun.color.copy(daylight.sunLight);
  sun.intensity =
    daylight.sunIntensity * smoothstep(-0.08, 0.04, sunDirection.y);
  moon.color.copy(daylight.moonLight);
  moon.intensity =
    daylight.moonIntensity * smoothstep(0.02, 0.22, moonDirection.y);
  hemi.color.copy(daylight.hemiSky);
  hemi.groundColor.copy(daylight.hemiGround);
  hemi.intensity = daylight.hemiIntensity;
  fill.color.copy(daylight.fillColor);
  fill.intensity = daylight.fillIntensity;
  bounce.color.copy(daylight.bounceColor);
  bounce.intensity = daylight.bounceIntensity;
  skyFill.color.copy(daylight.skyFillColor);
  skyFill.intensity = daylight.skyFillIntensity;

  scene.fog.color.copy(daylight.fog);
  scene.fog.density = daylight.fogDensity;
  renderer.toneMappingExposure = daylight.exposure;
  bloom.strength = daylight.bloomStrength;
  world.setDaylight(daylight);

  state.dayPhase = daylight.label;
  state.dayNight = daylight.night;
}

function tick() {
  const now = performance.now();
  const dt = Math.min((now - clock.last) / 1000, 0.05);
  clock.last = now;
  elapsed += dt;
  state.elapsed = elapsed;
  updateDayCycle(dt);

  if (state.mode === "intro") {
    state.introTime += dt;
    if (!state.freezeIntro) introDistance += 20.5 * dt;
    coursePoint(introDistance, introPoint);
    courseTangent(introDistance, introTangent);
    plane.updateAutopilot(dt, introPoint, introTangent, elapsed);
    updateIntroCamera(dt, state.introCameraTime ?? elapsed);
    world.ensureAhead(plane.position);
    world.setHighlight(world.nextRing(plane.position));
  } else {
    if (state.paused) {
      // Keep the world breathing, but hold the plane still. Plane morphs can
      // still finish while the game is paused.
      world.update(dt, elapsed, camera);
      plane.updateMorph(dt);
      updateChaseCamera(0.016, elapsed);
      updateSun(camera.position);
      composer.render();
      requestAnimationFrame(tick);
      return;
    }

    prevPosition.copy(plane.position);
    input.grace = Math.max(0, input.grace - dt);

    // After a long stillness the sky takes the controls itself. Holding the
    // soar key counts as active flight, so it keeps idle auto from starting.
    // Once the cinematic follow is active, the latch below keeps it engaged.
    if (keys["ShiftLeft"] || keys["ShiftRight"]) state.idleTime = 0;
    else state.idleTime += dt;
    if (!state.autoFly && state.idleTime > state.idleDelay) {
      setAutoFly(true, "idle");
    }

    // Once the cinematic follow takes over, ordinary activity no longer
    // dismisses it. It stays until auto-flight is disengaged or a camera
    // preset is chosen explicitly.
    if (!state.autoFly) {
      state.cameraCinematic = false;
    } else if (
      state.idleTime >= CINEMATIC_IDLE_TIME &&
      !state.cameraCinematic
    ) {
      state.cameraCinematic = true;
      state.cinematicTime = 0;
      showToast("The sky watches", "pan & tilt follow");
    }
    if (state.cameraCinematic) state.cinematicTime += dt;

    let flightInput = readInput(dt);
    if (state.autoFly) {
      const hoop = world.nextRingAhead(plane.position);
      let bankBias = 0;
      if (hoop) {
        // Aim a touch past the centre so the plane commits through the hoop.
        autoTarget.copy(hoop.center).addScaledVector(hoop.normal, 4);

        // A slow, breathing sideways lean keeps the autopilot from looking
        // mechanically perfect. It fades out close to the hoop so the plane
        // still threads the centre cleanly.
        autoApproach.set(
          hoop.center.x - plane.position.x,
          0,
          hoop.center.z - plane.position.z
        );
        autoSide.set(-autoApproach.z, 0, autoApproach.x);
        const targetDistance = autoTarget.distanceTo(plane.position);
        const fade = clamp((targetDistance - 22) / 55, 0, 1);
        if (fade > 0 && autoSide.lengthSq() > 0.0001) {
          autoSide.normalize();
          const phase = elapsed * 0.57 + hoop.distance * 0.021;
          const pulse =
            Math.sin(phase) * (0.55 + 0.45 * Math.sin(elapsed * 0.19 + 1.7));
          autoTarget.addScaledVector(
            autoSide,
            pulse * AUTO_FLOURISH_OFFSET * fade
          );
          bankBias = pulse * AUTO_FLOURISH_BANK * fade;
        }
      } else {
        coursePoint(-plane.position.z + 110, autoTarget);
      }
      flightInput = plane.autoInput(autoTarget, bankBias);
      // Shift is an optional speed boost even while the sky flies the plane.
      flightInput.boost = input.boost;
    }

    const floorBump = plane.updateFlight(dt, flightInput, elapsed);
    if (floorBump && Math.random() < 0.03) showToast("The clouds lift you", "");

    world.ensureAhead(plane.position);

    // A gentle tailwind keeps the plane dreaming toward the next ring
    // whenever the pilot's hands are still.
    const assistRing = world.nextRing(plane.position);
    if (!state.autoFly && !flightInput.hasInput && assistRing) {
      plane.applyWind(dt, assistRing.center, 1.1);
    }

    const { collected, missed } = world.checkRings(prevPosition, plane.position);
    for (const ring of collected) addRingScore(ring);
    if (missed.length) missRing();

    const next = world.nextRing(plane.position);
    world.setHighlight(next);
    updateTargetMarker(next);

    handleCollisions();
    updateChaseCamera(dt, elapsed);

    // A forgiving ceiling: above the warm air, the sunset itself nudges you down.
    if (plane.position.y > 180) {
      plane.position.y = damp(plane.position.y, 180, 2.5, dt);
      plane.pitch = damp(plane.pitch, -0.28, 2.2, dt);
    }

    state.hintTimer += dt;
    state.objectiveTimer += dt;
    if (state.hintTimer > 9) ui.controlHint.classList.add("hide-hint");
    if (state.objectiveTimer > 7) ui.objective.classList.add("dim");
  }

  world.update(dt, elapsed, camera);
  windStreaks.update(dt, elapsed, plane, plane.speed);
  motes.update(dt, elapsed, plane);
  updateSun(camera.position);

  // HUD.
  state.displayScore = damp(state.displayScore, state.score, 8, dt);
  ui.score.textContent = Math.round(state.displayScore).toLocaleString("en-US");
  ui.altitude.textContent = String(Math.round(plane.position.y));
  ui.speed.textContent = String(Math.round(plane.speed));
  ui.speedFill.style.transform = `scaleX(${clamp((plane.speed - 18) / 40, 0.05, 1)})`;
  gradePass.uniforms.uTime.value = elapsed;

  composer.render();

  if (firstFrame) {
    firstFrame = false;
    requestAnimationFrame(() => document.body.classList.add("loaded"));
  }
  requestAnimationFrame(tick);
}

/* ————— Boot ————— */

resize();
// Warm up the shader cache before the curtain lifts.
try {
  renderer.compile(scene, camera);
} catch (error) {
  console.warn("Shader warm-up skipped", error);
}
requestAnimationFrame(tick);

// Expose a tiny diagnostic hook for the console.
window.__sky = {
  scene,
  camera,
  renderer,
  world,
  plane,
  sound,
  state,
  cameraRig,
  cameraTween,
  setIntro(d, cameraTime = null) {
    introDistance = d;
    state.freezeIntro = true;
    state.introCameraTime = cameraTime;
  },
  releaseIntro() {
    state.freezeIntro = false;
    state.introCameraTime = null;
  },
};
