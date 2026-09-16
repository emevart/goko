import { useEffect, useRef, useState } from 'react';
import { mixOrbVisual, orbVisualForState, smoothOrbLevel, transitionProgress, type OrbState, type OrbVisual } from '../orb.ts';

type Props = { state: OrbState; level: number };
type ThreeModule = typeof import('three');
type Uniform = { value: unknown };
type SphereUniforms = {
  uTime: Uniform;
  uLevel: Uniform;
  uDeformation: Uniform;
  uVoiceDeformation: Uniform;
  uBreath: Uniform;
  uPulse: Uniform;
  uColorA: Uniform;
  uColorB: Uniform;
  uGlow: Uniform;
  uOpacity: Uniform;
};
type ShellUniforms = { uGlow: Uniform; uOpacity: Uniform };

// Поверхность — единственный главный объект сцены. Несколько октав шума дают
// живые асимметричные складки вместо геометрических колец и декоративных линий.
const SPHERE_VERTEX = /* glsl */ `
  precision mediump float;
  uniform float uTime;
  uniform float uLevel;
  uniform float uDeformation;
  uniform float uVoiceDeformation;
  uniform float uBreath;
  uniform float uPulse;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying float vField;
  varying float vVoice;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += noise3(p) * amplitude;
      p = p * 2.03 + vec3(11.7, 3.1, 7.4);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 direction = normalize(position);
    float flow = max(0.08, uPulse + 0.25);
    vec3 domain = direction * (1.45 + uPulse * 0.35);
    domain += vec3(uTime * 0.17, -uTime * 0.13, uTime * 0.11) * flow;
    domain += vec3(sin(uTime * 0.23), cos(uTime * 0.19), sin(uTime * 0.17)) * 0.24;

    float field = fbm(domain);
    float detail = fbm(domain * 2.15 - vec3(uTime * 0.31, uTime * 0.27, -uTime * 0.24));
    float voice = smoothstep(0.015, 0.62, uLevel);
    float ripple = 0.5 + 0.5 * sin(field * 9.0 + detail * 5.0 + uTime * (1.15 + flow));
    float breath = sin(uTime * (0.72 + uPulse * 1.15) + field * 5.5) * uBreath;
    float displacement = uDeformation * (0.34 + field * 0.88)
      + uVoiceDeformation * voice * (0.18 + ripple * 0.92)
      + breath;

    // Небольшое касательное смещение делает голосовую волну текучей, а не
    // равномерным увеличением сферы.
    vec3 tangent = normalize(vec3(direction.y + 0.001, -direction.z + 0.001, direction.x + 0.001));
    float twist = sin(detail * 7.0 + uTime * 0.8) * uVoiceDeformation * voice * 0.018;
    vec3 p = position + direction * displacement + tangent * twist;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(normalMatrix * direction);
    vField = field;
    vVoice = voice;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SPHERE_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying float vField;
  varying float vVoice;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 normal = normalize(vNormal);
    float facing = max(dot(normal, viewDir), 0.0);
    float fresnel = pow(1.0 - facing, 2.35);
    float light = 0.52 + 0.48 * max(dot(normal, normalize(vec3(-0.42, 0.76, 0.58))), 0.0);
    float flowLight = smoothstep(0.1, 0.92, light + (vField - 0.4) * 0.22);
    vec3 color = mix(uColorB, uColorA, flowLight);
    color += uGlow * (fresnel * (0.74 + vVoice * 0.8) + vField * 0.055);
    float alpha = uOpacity * (0.75 + light * 0.18 + fresnel * 0.2);
    gl_FragColor = vec4(color, alpha);
  }
`;

const SHELL_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SHELL_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 2.15);
    gl_FragColor = vec4(uGlow, rim * uOpacity);
  }
`;

const safeLevel = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

function applyVisual(THREE: ThreeModule, visual: OrbVisual, sphereUniforms: SphereUniforms, shellUniforms: ShellUniforms, root: InstanceType<ThreeModule['Group']>) {
  const colorA = visual.colorA;
  const colorB = visual.colorB;
  const glow = visual.glow;
  (sphereUniforms.uColorA.value as InstanceType<ThreeModule['Color']>).setRGB(colorA[0], colorA[1], colorA[2]);
  (sphereUniforms.uColorB.value as InstanceType<ThreeModule['Color']>).setRGB(colorB[0], colorB[1], colorB[2]);
  (sphereUniforms.uGlow.value as InstanceType<ThreeModule['Color']>).setRGB(glow[0], glow[1], glow[2]);
  (shellUniforms.uGlow.value as InstanceType<ThreeModule['Color']>).setRGB(glow[0], glow[1], glow[2]);
  sphereUniforms.uOpacity.value = visual.opacity;
  sphereUniforms.uDeformation.value = visual.deformation;
  sphereUniforms.uVoiceDeformation.value = visual.voiceDeformation;
  sphereUniforms.uBreath.value = visual.breath;
  sphereUniforms.uPulse.value = visual.pulse;
  shellUniforms.uOpacity.value = 0.28 * visual.opacity;
  root.scale.setScalar(visual.scale);
}

export function VoiceOrb3D({ state, level }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<OrbState>(state);
  const levelRef = useRef(safeLevel(level));
  const renderRef = useRef<(() => void) | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    stateRef.current = state;
    levelRef.current = safeLevel(level);
    renderRef.current?.();
  }, [state, level]);

  useEffect(() => {
    let cancelled = false;
    let destroy = () => {};

    void import('three').then((THREE) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      let renderer: InstanceType<ThreeModule['WebGLRenderer']>;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      } catch {
        // CSS-орб под canvas остаётся рабочим fallback при запрете или отсутствии WebGL.
        if (!cancelled) setFallback(true);
        return;
      }
      if (!cancelled) setFallback(false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      renderer.setClearAlpha(0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
      camera.position.z = 3.25;
      const root = new THREE.Group();
      scene.add(root);

      const sphereUniforms = {
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uDeformation: { value: 0.02 },
        uVoiceDeformation: { value: 0 },
        uBreath: { value: 0.01 },
        uPulse: { value: 0.2 },
        uColorA: { value: new THREE.Color() },
        uColorB: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uOpacity: { value: 0.9 },
      };
      const sphereGeometry = new THREE.IcosahedronGeometry(1, 5);
      const sphereMaterial = new THREE.ShaderMaterial({ uniforms: sphereUniforms, vertexShader: SPHERE_VERTEX, fragmentShader: SPHERE_FRAGMENT, transparent: true });
      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
      root.add(sphere);

      // Тонкий Fresnel-слой остаётся частью сферы и не рисует отдельную рамку.
      const shellUniforms = { uGlow: { value: new THREE.Color() }, uOpacity: { value: 0.3 } };
      const shellGeometry = new THREE.SphereGeometry(1.075, 40, 24);
      const shellMaterial = new THREE.ShaderMaterial({ uniforms: shellUniforms, vertexShader: SHELL_VERTEX, fragmentShader: SHELL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide });
      const shell = new THREE.Mesh(shellGeometry, shellMaterial);
      root.add(shell);

      const initial = orbVisualForState(stateRef.current);
      let visual = initial;
      let from = initial;
      let to = initial;
      let activeState = stateRef.current;
      let transitionStarted = performance.now();
      let smoothedLevel = 0;
      let lastTime = transitionStarted;
      let frame = 0;
      let running = true;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width || 82);
        const height = Math.max(1, rect.height || width);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resize();
      window.addEventListener('resize', resize);
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
      resizeObserver?.observe(canvas);

      const render = (now = performance.now()) => {
        const delta = Math.min(80, Math.max(0, now - lastTime));
        lastTime = now;
        const nextState = stateRef.current;
        if (nextState !== activeState) {
          from = visual;
          to = orbVisualForState(nextState);
          activeState = nextState;
          transitionStarted = now;
        }
        visual = mixOrbVisual(from, to, transitionProgress(now - transitionStarted));
        smoothedLevel = smoothOrbLevel(smoothedLevel, levelRef.current, delta);
        const seconds = now / 1000;
        const motion = reducedMotion ? 0 : 1;
        sphereUniforms.uTime.value = seconds * visual.speed * motion;
        sphereUniforms.uLevel.value = smoothedLevel;
        applyVisual(THREE, visual, sphereUniforms, shellUniforms, root);
        if (motion) {
          root.rotation.y += delta * 0.00008 * visual.speed;
          root.rotation.x = Math.sin(seconds * 0.35 * visual.speed) * 0.045;
        }
        renderer.render(scene, camera);
      };
      renderRef.current = () => render();
      render();
      const tick = (now: number) => {
        if (!running) return;
        render(now);
        frame = requestAnimationFrame(tick);
      };
      if (!reducedMotion) frame = requestAnimationFrame(tick);

      destroy = () => {
        running = false;
        cancelAnimationFrame(frame);
        renderRef.current = null;
        window.removeEventListener('resize', resize);
        resizeObserver?.disconnect();
        sphereGeometry.dispose();
        sphereMaterial.dispose();
        shellGeometry.dispose();
        shellMaterial.dispose();
        scene.clear();
        renderer.dispose();
      };
    }).catch(() => {
      // Ошибка ленивого импорта Three.js не должна ломать разговор: CSS-слой уже виден.
      if (!cancelled) setFallback(true);
    });

    return () => {
      cancelled = true;
      destroy();
    };
  }, []);

  return (
    <>
      <span className={`voice-orb-fallback${fallback ? ' voice-orb-fallback-visible' : ''}`} aria-hidden="true" />
      <canvas ref={canvasRef} className="voice-orb-canvas" aria-hidden="true" />
    </>
  );
}
