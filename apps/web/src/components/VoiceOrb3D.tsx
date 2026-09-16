import { useEffect, useRef } from 'react';
import { mixOrbVisual, orbVisualForState, smoothOrbLevel, transitionProgress, type OrbState, type OrbVisual } from '../orb.ts';

type Props = { state: OrbState; level: number };
type ThreeModule = typeof import('three');
type Uniform = { value: unknown };
type SphereUniforms = { uTime: Uniform; uLevel: Uniform; uPulse: Uniform; uColorA: Uniform; uColorB: Uniform; uGlow: Uniform; uOpacity: Uniform };
type ShellUniforms = { uGlow: Uniform; uOpacity: Uniform };

const SPHERE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uPulse;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 p = position;
    float wave = sin(p.x * 5.0 + uTime * 1.7)
      + sin(p.y * 6.0 - uTime * 1.25)
      + sin(p.z * 7.0 + uTime * 0.9);
    p += normal * wave * (0.006 + uLevel * 0.026) * (0.45 + uPulse);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SPHERE_FRAGMENT = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uGlow;
  uniform float uOpacity;
  uniform float uLevel;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float facing = max(dot(normalize(vNormal), viewDir), 0.0);
    float fresnel = pow(1.0 - facing, 2.4);
    float light = 0.52 + 0.48 * max(dot(normalize(vNormal), normalize(vec3(-0.35, 0.8, 0.6))), 0.0);
    vec3 color = mix(uColorB, uColorA, light);
    color += uGlow * (fresnel * (0.68 + uLevel * 0.72));
    gl_FragColor = vec4(color, uOpacity * (0.78 + fresnel * 0.22));
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
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 2.1);
    gl_FragColor = vec4(uGlow, rim * uOpacity);
  }
`;

const safeLevel = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

function applyVisual(THREE: ThreeModule, visual: OrbVisual, sphereUniforms: SphereUniforms, shellUniforms: ShellUniforms, ringMaterials: Array<InstanceType<ThreeModule['MeshBasicMaterial']>>, particleMaterial: InstanceType<ThreeModule['PointsMaterial']>, root: InstanceType<ThreeModule['Group']>) {
  const colorA = visual.colorA;
  const colorB = visual.colorB;
  const glow = visual.glow;
  (sphereUniforms.uColorA.value as InstanceType<ThreeModule['Color']>).setRGB(colorA[0], colorA[1], colorA[2]);
  (sphereUniforms.uColorB.value as InstanceType<ThreeModule['Color']>).setRGB(colorB[0], colorB[1], colorB[2]);
  (sphereUniforms.uGlow.value as InstanceType<ThreeModule['Color']>).setRGB(glow[0], glow[1], glow[2]);
  (shellUniforms.uGlow.value as InstanceType<ThreeModule['Color']>).setRGB(glow[0], glow[1], glow[2]);
  sphereUniforms.uOpacity.value = visual.opacity;
  shellUniforms.uOpacity.value = 0.34 * visual.opacity;
  root.scale.setScalar(visual.scale);
  for (const material of ringMaterials) {
    material.color.setRGB(glow[0], glow[1], glow[2]);
    material.opacity = 0.25 + visual.opacity * 0.38;
  }
  particleMaterial.color.setRGB(colorA[0], colorA[1], colorA[2]);
  particleMaterial.opacity = 0.22 + visual.opacity * 0.52;
}

function createParticlePositions(THREE: ThreeModule, count: number): InstanceType<ThreeModule['BufferAttribute']> {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 1.12 + (i % 7) * 0.075;
    const theta = i * 2.3999632297;
    const phi = Math.acos(1 - 2 * ((i + 0.5) / count));
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  return new THREE.Float32BufferAttribute(positions, 3);
}

export function VoiceOrb3D({ state, level }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<OrbState>(state);
  const levelRef = useRef(safeLevel(level));
  const renderRef = useRef<(() => void) | null>(null);

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
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
      camera.position.z = 3.25;
      const root = new THREE.Group();
      scene.add(root);

      const sphereUniforms = {
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uPulse: { value: 0 },
        uColorA: { value: new THREE.Color() },
        uColorB: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uOpacity: { value: 0.9 },
      };
      const sphereGeometry = new THREE.IcosahedronGeometry(1, 5);
      const sphereMaterial = new THREE.ShaderMaterial({ uniforms: sphereUniforms, vertexShader: SPHERE_VERTEX, fragmentShader: SPHERE_FRAGMENT, transparent: true });
      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
      root.add(sphere);

      const shellUniforms = { uGlow: { value: new THREE.Color() }, uOpacity: { value: 0.3 } };
      const shellGeometry = new THREE.SphereGeometry(1.085, 32, 20);
      const shellMaterial = new THREE.ShaderMaterial({ uniforms: shellUniforms, vertexShader: SHELL_VERTEX, fragmentShader: SHELL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide });
      const shell = new THREE.Mesh(shellGeometry, shellMaterial);
      root.add(shell);

      const ringMaterials = [
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false }),
      ];
      const ringGeometry = new THREE.TorusGeometry(1.2, 0.014, 8, 96);
      const ringOne = new THREE.Mesh(ringGeometry, ringMaterials[0]);
      ringOne.rotation.x = Math.PI / 2.5;
      ringOne.rotation.z = Math.PI / 7;
      const ringTwo = new THREE.Mesh(ringGeometry.clone(), ringMaterials[1]);
      ringTwo.rotation.x = Math.PI / 3.1;
      ringTwo.rotation.y = Math.PI / 4;
      root.add(ringOne, ringTwo);

      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute('position', createParticlePositions(THREE, window.matchMedia('(max-width: 480px)').matches ? 34 : 58));
      const particleMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const particles = new THREE.Points(particleGeometry, particleMaterial);
      root.add(particles);

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
        sphereUniforms.uPulse.value = visual.pulse;
        applyVisual(THREE, visual, sphereUniforms, shellUniforms, ringMaterials, particleMaterial, root);
        if (motion) {
          root.rotation.y += delta * 0.00008 * visual.speed;
          root.rotation.x = Math.sin(seconds * 0.35 * visual.speed) * 0.06;
          ringOne.rotation.z += delta * 0.0007 * visual.ringSpeed;
          ringTwo.rotation.x += delta * 0.00045 * visual.ringSpeed;
          particles.rotation.y -= delta * 0.00035 * visual.particleSpeed;
          particles.rotation.z += delta * 0.00018 * visual.particleSpeed;
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
        ringGeometry.dispose();
        ringTwo.geometry.dispose();
        for (const material of ringMaterials) material.dispose();
        particleGeometry.dispose();
        particleMaterial.dispose();
        scene.clear();
        renderer.dispose();
      };
    }).catch(() => {
      // Ошибка ленивого импорта Three.js не должна ломать разговор: CSS-слой уже виден.
    });

    return () => {
      cancelled = true;
      destroy();
    };
  }, []);

  return <canvas ref={canvasRef} className="voice-orb-canvas" aria-hidden="true" />;
}
