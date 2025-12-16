import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sun, Wind, Sparkles, Info, Cpu, MousePointer2 } from 'lucide-react';
import htm from 'htm';

const html = htm.bind(React.createElement);

export default function WebGPUTerrainDemo() {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('initializing');
  const [stats, setStats] = useState({ fps: 0, triangles: 0 });
  const rendererRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let renderer, scene, camera, terrain, grassInstances, particles;
    let character, mixer, idleAction, runAction, currentAction;
    let moveTarget = null;
    let clickMarker;
    let cleanupClick;
    
    let animationId;
    let time = 0;

    async function init() {
      try {
        // Check WebGPU support at browser level first
        if (!navigator.gpu) {
          setStatus('WebGPU not supported. Please use Chrome 113+ with WebGPU enabled.');
          return;
        }

        setStatus('Initializing WebGPU...');

        // Dynamic imports for WebGPU modules to prevent crash if not available
        // Handling both named and default exports for compatibility
        const capabilityModule = await import('three/addons/capabilities/WebGPU.js');
        const WebGPU = capabilityModule.default || capabilityModule.WebGPU;

        if (!await WebGPU.isAvailable()) {
          setStatus('WebGPU not available');
          return;
        }

        const webGPUModule = await import('three/webgpu');
        const WebGPURenderer = webGPUModule.WebGPURenderer || webGPUModule.default;

        // Scene setup
        scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x87ceeb, 50, 200);

        // Camera
        camera = new THREE.PerspectiveCamera(
          60,
          containerRef.current.offsetWidth / containerRef.current.offsetHeight,
          0.1,
          500
        );
        camera.position.set(0, 15, 40);
        camera.lookAt(0, 0, 0);

        // WebGPU Renderer
        renderer = new WebGPURenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(containerRef.current.offsetWidth, containerRef.current.offsetHeight);
        
        // Tone mapping
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        
        containerRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        setStatus('Building scene...');

        // Dynamic Sky
        const skyGeo = new THREE.SphereGeometry(300, 32, 32);
        const skyMat = new THREE.MeshBasicMaterial({
          color: 0x87ceeb,
          side: THREE.BackSide
        });
        const sky = new THREE.Mesh(skyGeo, skyMat);
        scene.add(sky);

        // Sun (Directional Light with shadows)
        const sun = new THREE.DirectionalLight(0xfff5e6, 2.5);
        sun.position.set(50, 60, 30);
        sun.castShadow = true;
        // Shadow map settings
        sun.shadow.mapSize.width = 2048;
        sun.shadow.mapSize.height = 2048;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 200;
        sun.shadow.camera.left = -50;
        sun.shadow.camera.right = 50;
        sun.shadow.camera.top = 50;
        sun.shadow.camera.bottom = -50;
        sun.shadow.bias = -0.0005; 
        scene.add(sun);

        // Ambient light
        const ambient = new THREE.AmbientLight(0x404060, 0.8);
        scene.add(ambient);

        // Hemisphere light for natural sky fill
        const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a6f3a, 0.6);
        scene.add(hemiLight);

        // Create detailed terrain with displacement
        const terrainGeo = new THREE.PlaneGeometry(200, 200, 128, 128);
        const vertices = terrainGeo.attributes.position.array;
        
        // Procedural height generation
        for (let i = 0; i < vertices.length; i += 3) {
          const x = vertices[i];
          const y = vertices[i + 1];
          const noise = 
            Math.sin(x * 0.05) * Math.cos(y * 0.05) * 3 +
            Math.sin(x * 0.1) * Math.cos(y * 0.1) * 1.5 +
            Math.sin(x * 0.2) * Math.cos(y * 0.2) * 0.5;
          vertices[i + 2] = noise;
        }
        terrainGeo.computeVertexNormals();

        // PBR Material for terrain
        const terrainMat = new THREE.MeshStandardMaterial({
          color: 0x4a6f3a,
          roughness: 0.95,
          metalness: 0.0,
          flatShading: false
        });

        terrain = new THREE.Mesh(terrainGeo, terrainMat);
        terrain.rotation.x = -Math.PI / 2;
        terrain.receiveShadow = true;
        scene.add(terrain);

        // Instanced grass blades
        const grassBlade = new THREE.ConeGeometry(0.05, 1.5, 3);
        grassBlade.translate(0, 0.75, 0);
        
        const grassMat = new THREE.MeshStandardMaterial({
          color: 0x5a8f4a,
          roughness: 0.9,
          metalness: 0.0,
          side: THREE.DoubleSide
        });

        grassInstances = new THREE.InstancedMesh(grassBlade, grassMat, 5000);
        grassInstances.castShadow = true;
        grassInstances.receiveShadow = true;

        const dummy = new THREE.Object3D();
        for (let i = 0; i < 5000; i++) {
          const x = (Math.random() - 0.5) * 80;
          const z = (Math.random() - 0.5) * 80;
          const y = getTerrainHeight(x, z);
          
          dummy.position.set(x, y, z);
          dummy.rotation.y = Math.random() * Math.PI * 2;
          dummy.scale.set(
            0.8 + Math.random() * 0.4,
            0.8 + Math.random() * 0.6,
            0.8 + Math.random() * 0.4
          );
          dummy.updateMatrix();
          grassInstances.setMatrixAt(i, dummy.matrix);
        }
        scene.add(grassInstances);

        // Particle system (fireflies)
        const particleGeo = new THREE.BufferGeometry();
        const particleCount = 500;
        const positions = new Float32Array(particleCount * 3);
        const velocities = [];

        for (let i = 0; i < particleCount; i++) {
          positions[i * 3] = (Math.random() - 0.5) * 100;
          positions[i * 3 + 1] = Math.random() * 30 + 5;
          positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
          
          velocities.push({
            x: (Math.random() - 0.5) * 0.02,
            y: Math.random() * 0.02,
            z: (Math.random() - 0.5) * 0.02
          });
        }

        particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const particleMat = new THREE.PointsMaterial({
          color: 0xffeb99,
          size: 0.3,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          sizeAttenuation: true,
          depthWrite: false
        });

        particles = new THREE.Points(particleGeo, particleMat);
        particles.userData.velocities = velocities;
        scene.add(particles);

        // Character Setup
        const loader = new GLTFLoader();
        // Click marker
        const markerGeo = new THREE.RingGeometry(0.4, 0.6, 32);
        const markerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
        clickMarker = new THREE.Mesh(markerGeo, markerMat);
        clickMarker.rotation.x = -Math.PI / 2;
        clickMarker.visible = false;
        scene.add(clickMarker);

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();

        loader.load('https://threejs.org/examples/models/gltf/Soldier.glb', (gltf) => {
          character = gltf.scene;
          character.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          scene.add(character);

          mixer = new THREE.AnimationMixer(character);
          const animations = gltf.animations;
          idleAction = mixer.clipAction(animations.find(c => c.name === 'Idle'));
          runAction = mixer.clipAction(animations.find(c => c.name === 'Run'));
          
          idleAction.play();
          currentAction = idleAction;

          // Start at center
          character.position.set(0, getTerrainHeight(0, 0), 0);
        });

        function onPointerDown(event) {
          if (!terrain) return;
          
          pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
          pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

          raycaster.setFromCamera(pointer, camera);
          const intersects = raycaster.intersectObject(terrain);

          if (intersects.length > 0) {
            const point = intersects[0].point;
            moveTarget = point;
            
            clickMarker.position.copy(point);
            clickMarker.position.y += 0.2;
            clickMarker.visible = true;

            if (character && currentAction !== runAction) {
              currentAction.fadeOut(0.2);
              runAction.reset().fadeIn(0.2).play();
              currentAction = runAction;
            }
          }
        }

        window.addEventListener('pointerdown', onPointerDown);
        cleanupClick = () => window.removeEventListener('pointerdown', onPointerDown);

        // Add some rocks with PBR
        const rockGeo = new THREE.DodecahedronGeometry(1.5, 1);
        const rockMat = new THREE.MeshStandardMaterial({
          color: 0x666666,
          roughness: 0.9,
          metalness: 0.1
        });

        for (let i = 0; i < 15; i++) {
          const rock = new THREE.Mesh(rockGeo, rockMat);
          const x = (Math.random() - 0.5) * 70;
          const z = (Math.random() - 0.5) * 70;
          rock.position.set(x, getTerrainHeight(x, z) + 1, z);
          rock.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI
          );
          rock.scale.setScalar(0.5 + Math.random() * 1);
          rock.castShadow = true;
          rock.receiveShadow = true;
          scene.add(rock);
        }

        setStatus('rendering');

        // Animation loop
        let lastTime = performance.now();
        let frameCount = 0;
        let fpsTime = 0;

        function animate() {
          animationId = requestAnimationFrame(animate);

          const currentTime = performance.now();
          const deltaTime = currentTime - lastTime;
          lastTime = currentTime;
          time = currentTime * 0.001;
          const dt = deltaTime * 0.001; // seconds for mixer

          // FPS calculation
          frameCount++;
          fpsTime += deltaTime;
          if (fpsTime >= 1000) {
            setStats({
              fps: Math.round(frameCount * 1000 / fpsTime),
              triangles: Math.round(renderer.info.render.triangles / 1000)
            });
            frameCount = 0;
            fpsTime = 0;
          }

          // Animate grass with wind
          const dummy = new THREE.Object3D();
          for (let i = 0; i < 5000; i++) {
            grassInstances.getMatrixAt(i, dummy.matrix);
            dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
            
            // Simple CPU wind simulation
            const windX = Math.sin(time + dummy.position.x * 0.1) * 0.1;
            const windZ = Math.cos(time + dummy.position.z * 0.1) * 0.1;
            
            dummy.rotation.x = windX;
            dummy.rotation.z = windZ;
            dummy.updateMatrix();
            grassInstances.setMatrixAt(i, dummy.matrix);
          }
          grassInstances.instanceMatrix.needsUpdate = true;

          // Update Character & Camera
          if (mixer) mixer.update(dt);

          if (character) {
            if (moveTarget) {
              const direction = new THREE.Vector3().subVectors(moveTarget, character.position);
              direction.y = 0;
              const dist = direction.length();

              if (dist > 0.5) {
                direction.normalize();
                const moveSpeed = 8;
                character.position.add(direction.multiplyScalar(moveSpeed * dt));
                character.position.y = getTerrainHeight(character.position.x, character.position.z);
                
                // Smooth rotation
                const lookTarget = new THREE.Vector3(moveTarget.x, character.position.y, moveTarget.z);
                character.lookAt(lookTarget);
              } else {
                moveTarget = null;
                clickMarker.visible = false;
                if (currentAction !== idleAction) {
                  currentAction.fadeOut(0.2);
                  idleAction.reset().fadeIn(0.2).play();
                  currentAction = idleAction;
                }
              }
            }

            // Cinematic Camera Follow
            // Target position: behind and above character
            const camOffset = new THREE.Vector3(0, 12, 16); 
            const targetCamPos = character.position.clone().add(camOffset);
            
            // Smoothly interpolate camera position
            camera.position.lerp(targetCamPos, 0.05);
            camera.lookAt(character.position.clone().add(new THREE.Vector3(0, 2, 0))); // Look slightly above feet
          } else {
             // Fallback default camera movement if character not loaded
             sun.position.x = Math.cos(time * 0.1) * 50;
             sun.position.y = Math.abs(Math.sin(time * 0.1)) * 60 + 20;
             sun.position.z = Math.sin(time * 0.1) * 30;

             camera.position.x = Math.sin(time * 0.1) * 5;
             camera.position.y = 15 + Math.sin(time * 0.05) * 2;
             camera.lookAt(0, 0, 0);
          }

          // Animate particles
          const positions = particles.geometry.attributes.position.array;
          const velocities = particles.userData.velocities;
          
          for (let i = 0; i < velocities.length; i++) {
            positions[i * 3] += velocities[i].x;
            positions[i * 3 + 1] += velocities[i].y;
            positions[i * 3 + 2] += velocities[i].z;

            // Boundary check - bounce or wrap
            if (Math.abs(positions[i * 3]) > 50) velocities[i].x *= -1;
            if (positions[i * 3 + 1] > 35 || positions[i * 3 + 1] < 5) velocities[i].y *= -1;
            if (Math.abs(positions[i * 3 + 2]) > 50) velocities[i].z *= -1;
          }
          particles.geometry.attributes.position.needsUpdate = true;

          renderer.render(scene, camera);
        }

        animate();

      } catch (error) {
        console.error('WebGPU Error:', error);
        setStatus(`Error: ${error.message}. WebGPU requires Chrome 113+ with flag enabled.`);
      }
    }

    function getTerrainHeight(x, z) {
      return Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
             Math.sin(x * 0.1) * Math.cos(z * 0.1) * 1.5;
    }

    function handleResize() {
      if (!containerRef.current || !rendererRef.current) return;
      camera.aspect = containerRef.current.offsetWidth / containerRef.current.offsetHeight;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(
        containerRef.current.offsetWidth,
        containerRef.current.offsetHeight
      );
    }

    init();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (cleanupClick) cleanupClick();
      if (animationId) cancelAnimationFrame(animationId);
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (containerRef.current && rendererRef.current.domElement) {
          containerRef.current.removeChild(rendererRef.current.domElement);
        }
      }
    };
  }, []);

  return html`
    <div className="w-full h-screen bg-black relative overflow-hidden font-sans">
      <div ref=${containerRef} className="w-full h-full" />
      
      ${status !== 'rendering' && html`
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm z-50">
          <div className="text-center text-white p-8 max-w-md">
            <${Cpu} className="w-16 h-16 mx-auto mb-4 text-blue-400 animate-pulse" />
            <h2 className="text-2xl font-bold mb-4">WebGPU Terrain Scene</h2>
            <p className="text-gray-300">${status}</p>
            ${status.includes('not supported') && html`
              <div className="mt-4 text-sm text-yellow-400 bg-yellow-400/10 p-4 rounded border border-yellow-400/20">
                To enable WebGPU in Chrome:<br/>
                1. Go to <code className="bg-black/30 px-1 rounded">chrome://flags/#enable-unsafe-webgpu</code><br/>
                2. Set to "Enabled"<br/>
                3. Relaunch Chrome
              </div>
            `}
          </div>
        </div>
      `}

      ${status === 'rendering' && html`
        <${React.Fragment}>
          <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm text-white p-4 rounded-lg border border-white/20 select-none pointer-events-none">
            <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
              <${Sparkles} className="w-5 h-5 text-yellow-400" />
              WebGPU Realtime 3D
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <${Sun} className="w-4 h-4 text-orange-400" />
                <span>PBR Materials + Shadows</span>
              </div>
              <div className="flex items-center gap-2">
                <${Wind} className="w-4 h-4 text-blue-400" />
                <span>5,000 Instanced Blades</span>
              </div>
              <div className="flex items-center gap-2">
                <${MousePointer2} className="w-4 h-4 text-purple-400" />
                <span>Click to Move Character</span>
              </div>
              <div className="pt-2 border-t border-white/20 space-y-1">
                <div className="text-green-400 font-mono">${stats.fps} FPS</div>
                <div className="text-blue-400 font-mono">${stats.triangles}K Triangles</div>
              </div>
            </div>
          </div>

          <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg border border-white/20 text-xs hidden md:block select-none pointer-events-none">
            <div className="font-bold mb-1">WebGPU Features:</div>
            <div className="text-gray-300">• GPU-accelerated rendering</div>
            <div className="text-gray-300">• Real-time shadow mapping</div>
            <div className="text-gray-300">• Physically-based materials</div>
            <div className="text-gray-300">• Instanced mesh rendering</div>
            <div className="text-gray-300">• Dynamic lighting system</div>
          </div>
        </${React.Fragment}>
      `}
    </div>
  `;
}

