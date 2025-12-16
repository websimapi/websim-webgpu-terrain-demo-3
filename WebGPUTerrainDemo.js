import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sun, Wind, Sparkles, MousePointer2, Loader2 } from 'lucide-react';
import htm from 'htm';

const html = htm.bind(React.createElement);

export default function WebGPUTerrainDemo() {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('initializing');
  const [stats, setStats] = useState({ fps: 0, triangles: 0 });
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let renderer, scene, camera, terrain, grassInstances, particles;
    let grassUniforms = { uTime: { value: 0 }, uPlayerPos: { value: new THREE.Vector3(0, -100, 0) } };
    let character, characterModel, mixer, idleAction, runAction, currentAction;
    let moveTarget = null;
    let clickMarker;
    let cleanupClick;
    
    let animationId;
    let time = 0;

    async function init() {
      try {
        setStatus('Initializing 3D Scene...');

        // Scene setup
        scene = new THREE.Scene();
        sceneRef.current = scene;
        scene.background = new THREE.Color(0x87ceeb);
        scene.fog = new THREE.Fog(0x87ceeb, 20, 100);

        // Camera
        camera = new THREE.PerspectiveCamera(
          60,
          containerRef.current.offsetWidth / containerRef.current.offsetHeight,
          0.1,
          500
        );
        camera.position.set(0, 15, 20);
        camera.lookAt(0, 0, 0);

        // Standard WebGL Renderer (Stable)
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(containerRef.current.offsetWidth, containerRef.current.offsetHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        
        containerRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // Dynamic Sky
        const skyGeo = new THREE.SphereGeometry(300, 32, 32);
        const skyMat = new THREE.MeshBasicMaterial({
          color: 0x87ceeb,
          side: THREE.BackSide
        });
        const sky = new THREE.Mesh(skyGeo, skyMat);
        scene.add(sky);

        // Lighting
        const sun = new THREE.DirectionalLight(0xfff5e6, 2.0);
        sun.position.set(50, 60, 30);
        sun.castShadow = true;
        sun.shadow.mapSize.width = 2048;
        sun.shadow.mapSize.height = 2048;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 150;
        sun.shadow.camera.left = -50;
        sun.shadow.camera.right = 50;
        sun.shadow.camera.top = 50;
        sun.shadow.camera.bottom = -50;
        sun.shadow.bias = -0.0005; 
        scene.add(sun);

        const ambient = new THREE.AmbientLight(0x404060, 0.6);
        scene.add(ambient);

        const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a6f3a, 0.6);
        scene.add(hemiLight);

        // Terrain Generation
        const terrainGeo = new THREE.PlaneGeometry(200, 200, 128, 128);
        const vertices = terrainGeo.attributes.position.array;
        
        for (let i = 0; i < vertices.length; i += 3) {
          const x = vertices[i];
          const y = vertices[i + 1];
          // Match the getTerrainHeight function exactly
          const noise = 
            Math.sin(x * 0.05) * Math.cos(y * 0.05) * 3 +
            Math.sin(x * 0.1) * Math.cos(y * 0.1) * 1.5 +
            Math.sin(x * 0.2) * Math.cos(y * 0.2) * 0.5;
          vertices[i + 2] = noise;
        }
        terrainGeo.computeVertexNormals();

        const terrainMat = new THREE.MeshStandardMaterial({
          color: 0x4a6f3a,
          roughness: 0.8,
          metalness: 0.1,
          flatShading: false
        });

        terrain = new THREE.Mesh(terrainGeo, terrainMat);
        terrain.rotation.x = -Math.PI / 2;
        terrain.receiveShadow = true;
        scene.add(terrain);

        // Advanced Interactive Grass
        // Reduced height (0.35) and segments (2) for better performance with higher count
        const grassHeight = 0.35;
        const grassGeo = new THREE.PlaneGeometry(0.1, grassHeight, 1, 2);
        grassGeo.translate(0, grassHeight / 2, 0); // Pivot at base
        
        // Taper the grass blades
        const posAttribute = grassGeo.attributes.position;
        for (let i = 0; i < posAttribute.count; i++) {
          const y = posAttribute.getY(i);
          const taper = 1.0 - (y / grassHeight); 
          const x = posAttribute.getX(i);
          posAttribute.setX(i, x * taper); // Taper width
        }
        grassGeo.computeVertexNormals();

        const grassMat = new THREE.MeshStandardMaterial({
          color: 0xffffff, // White so we can tint in shader
          roughness: 0.6,
          metalness: 0.1,
          side: THREE.DoubleSide,
          onBeforeCompile: (shader) => {
            shader.uniforms.uTime = grassUniforms.uTime;
            shader.uniforms.uPlayerPos = grassUniforms.uPlayerPos;
            
            // Inject Vertex Shader logic
            shader.vertexShader = `
              uniform float uTime;
              uniform vec3 uPlayerPos;
              varying vec2 vGrassUv;
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
              '#include <begin_vertex>',
              `
              vec3 transformed = vec3( position );
              vGrassUv = uv;
              
              // World position of the instance
              vec4 instanceWorldPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
              instanceWorldPos = modelMatrix * instanceWorldPos;
              
              // Base bend factor based on vertex height (0.0 at bottom, 1.0 at top)
              float hRatio = position.y / ${grassHeight.toFixed(2)};
              
              // Non-linear stiffness (stiffer at bottom)
              float bendSensitivity = pow(hRatio, 2.0);

              // Wind Effect with more variation
              float windFreq = uTime * 1.5;
              float sway = sin(windFreq + instanceWorldPos.x * 0.5) * 0.5 + 
                           sin(windFreq * 1.2 + instanceWorldPos.z * 0.4) * 0.3 + 
                           sin(windFreq * 0.5 + instanceWorldPos.x * 0.2 + instanceWorldPos.z * 0.2) * 0.2;
              
              transformed.x += sway * 0.15 * bendSensitivity;
              transformed.z += sway * 0.05 * bendSensitivity;
              
              // Player Interaction
              float dist = distance(instanceWorldPos.xz, uPlayerPos.xz);
              float radius = 3.5; // Larger interaction radius
              
              if(dist < radius){
                 // Smoother interaction curve
                 float interaction = 1.0 - (dist / radius);
                 interaction = smoothstep(0.0, 1.0, interaction);
                 
                 // Direction away from player
                 vec2 pushDir = normalize(instanceWorldPos.xz - uPlayerPos.xz);
                 
                 // Push strength
                 float pushStrength = 1.5 * interaction;
                 
                 // Apply push (bending away)
                 transformed.x += pushDir.x * pushStrength * bendSensitivity;
                 transformed.z += pushDir.y * pushStrength * bendSensitivity;
                 
                 // Apply squash (lowering height to simulate bending over)
                 // Using a curve that preserves volume perception
                 transformed.y *= 1.0 - (interaction * 0.7 * bendSensitivity);
              }
              `
            );

            // Inject Fragment Shader logic for gradient color
            shader.fragmentShader = `
              varying vec2 vGrassUv;
            ` + shader.fragmentShader;
            
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <color_fragment>',
              `
              vec3 bottomColor = vec3(0.1, 0.3, 0.05);
              vec3 topColor = vec3(0.4, 0.7, 0.2);
              vec3 gradientColor = mix(bottomColor, topColor, vGrassUv.y);
              diffuseColor.rgb *= gradientColor;
              `
            );
          }
        });
        
        const grassCount = 800000; // Very dense grass
        grassInstances = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
        grassInstances.castShadow = false; 
        grassInstances.receiveShadow = true;
        grassInstances.frustumCulled = false; 

        const dummy = new THREE.Object3D();
        for (let i = 0; i < grassCount; i++) {
          const x = (Math.random() - 0.5) * 200; 
          const z = (Math.random() - 0.5) * 200;
          const y = getTerrainHeight(x, z);
          
          dummy.position.set(x, y, z);
          dummy.rotation.y = Math.random() * Math.PI * 2;
          
          // Smaller overall scale for finer grass
          const scale = 0.6 + Math.random() * 0.4;
          dummy.scale.set(scale, scale, scale);
          
          dummy.updateMatrix();
          grassInstances.setMatrixAt(i, dummy.matrix);
        }
        scene.add(grassInstances);

        // Fireflies
        const particleGeo = new THREE.BufferGeometry();
        const particleCount = 200;
        const pPos = new Float32Array(particleCount * 3);
        const velocities = [];

        for (let i = 0; i < particleCount; i++) {
          pPos[i * 3] = (Math.random() - 0.5) * 60;
          pPos[i * 3 + 1] = Math.random() * 10 + 2;
          pPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
          velocities.push({
             x: (Math.random() - 0.5) * 0.05, 
             y: (Math.random() - 0.5) * 0.02, 
             z: (Math.random() - 0.5) * 0.05
          });
        }
        particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        const particleMat = new THREE.PointsMaterial({
          color: 0xffaa00,
          size: 0.2,
          transparent: true,
          blending: THREE.AdditiveBlending
        });
        particles = new THREE.Points(particleGeo, particleMat);
        particles.userData = { velocities };
        scene.add(particles);

        // Click Marker
        const markerGeo = new THREE.RingGeometry(0.3, 0.5, 32);
        const markerMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
        clickMarker = new THREE.Mesh(markerGeo, markerMat);
        clickMarker.rotation.x = -Math.PI / 2;
        clickMarker.visible = false;
        scene.add(clickMarker);

        // Character Loading
        setStatus('Loading Character...');
        const loader = new GLTFLoader();
        
        loader.load('https://threejs.org/examples/models/gltf/Soldier.glb', (gltf) => {
          characterModel = gltf.scene;
          characterModel.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });

          // Rotate model 180 degrees
          characterModel.rotation.y = Math.PI;

          // Wrap in a group to separate movement logic from model rotation
          character = new THREE.Group();
          character.add(characterModel);
          
          // Initial character placement
          const startX = 0;
          const startZ = 0;
          const startY = getTerrainHeight(startX, startZ);
          character.position.set(startX, startY, startZ);
          
          scene.add(character);

          // Mixer controls the mesh, not the group
          mixer = new THREE.AnimationMixer(characterModel);
          const animations = gltf.animations;
          idleAction = mixer.clipAction(animations.find(c => c.name === 'Idle'));
          runAction = mixer.clipAction(animations.find(c => c.name === 'Run'));
          
          idleAction.play();
          currentAction = idleAction;

          setStatus('rendering');
        }, undefined, (err) => {
          console.error("Failed to load character", err);
          setStatus('Error loading character');
        });

        // Input Handling
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();

        function onPointerDown(event) {
          if (!terrain) return;
          
          // Calculate pointer position in normalized device coordinates (-1 to +1)
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(pointer, camera);
          const intersects = raycaster.intersectObject(terrain);

          if (intersects.length > 0) {
            const point = intersects[0].point;
            moveTarget = point;
            
            clickMarker.position.copy(point);
            clickMarker.position.y += 0.1;
            clickMarker.visible = true;

            if (character && currentAction !== runAction) {
              currentAction.fadeOut(0.2);
              runAction.reset().fadeIn(0.2).play();
              currentAction = runAction;
            }
          }
        }
        
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        cleanupClick = () => {
          if (renderer.domElement) renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        };

        // Animation Loop
        let lastTime = performance.now();
        let frameCount = 0;
        let fpsTime = 0;

        function animate() {
          animationId = requestAnimationFrame(animate);

          const currentTime = performance.now();
          const deltaTime = currentTime - lastTime;
          lastTime = currentTime;
          time = currentTime * 0.001;

          // Stats
          frameCount++;
          fpsTime += deltaTime;
          if (fpsTime >= 1000) {
            setStats({
              fps: Math.round(frameCount * 1000 / fpsTime),
              triangles: renderer.info.render.triangles
            });
            frameCount = 0;
            fpsTime = 0;
          }

          // Update Grass Uniforms
          grassUniforms.uTime.value = time;
          if (character) {
             grassUniforms.uPlayerPos.value.copy(character.position);
          }

          // Character Logic
          if (mixer) mixer.update(deltaTime * 0.001);

          if (character) {
            // Movement
            if (moveTarget) {
              const charPos = character.position.clone();
              charPos.y = 0;
              const targetPos = moveTarget.clone();
              targetPos.y = 0;
              
              const direction = new THREE.Vector3().subVectors(targetPos, charPos);
              const dist = direction.length();

              if (dist > 0.2) {
                direction.normalize();
                const moveSpeed = 6;
                
                const moveVec = direction.multiplyScalar(moveSpeed * deltaTime * 0.001);
                character.position.add(moveVec);
                
                // Snap to terrain height
                const h = getTerrainHeight(character.position.x, character.position.z);
                character.position.y = h;

                // Rotate character
                const lookPos = moveTarget.clone();
                lookPos.y = character.position.y;
                character.lookAt(lookPos);
              } else {
                moveTarget = null;
                clickMarker.visible = false;
                if (currentAction !== idleAction) {
                  currentAction.fadeOut(0.2);
                  idleAction.reset().fadeIn(0.2).play();
                  currentAction = idleAction;
                }
              }
            } else {
              // Idle snapping
              const h = getTerrainHeight(character.position.x, character.position.z);
              character.position.y = h;
            }

            // Cinematic Camera Follow
            const idealOffset = new THREE.Vector3(0, 8, -12);
            idealOffset.applyQuaternion(character.quaternion);
            idealOffset.add(character.position);
            
            const idealLookAt = new THREE.Vector3(0, 2, 0);
            idealLookAt.applyQuaternion(character.quaternion);
            idealLookAt.add(character.position);

            // Smoothly interpolate
            camera.position.lerp(idealOffset, 0.05);
            
            // For lookAt, we manually slerp the quaternion for smoother rotation
            const tempCam = camera.clone();
            tempCam.lookAt(idealLookAt);
            camera.quaternion.slerp(tempCam.quaternion, 0.05);
          }

          // Particles
          if (particles) {
            const pos = particles.geometry.attributes.position.array;
            const vels = particles.userData.velocities;
            for(let i=0; i<vels.length; i++) {
              pos[i*3] += vels[i].x;
              pos[i*3+1] += vels[i].y;
              pos[i*3+2] += vels[i].z;
              
              if(pos[i*3+1] < 1 || pos[i*3+1] > 15) vels[i].y *= -1;
              if(Math.abs(pos[i*3]) > 60) vels[i].x *= -1;
              if(Math.abs(pos[i*3+2]) > 60) vels[i].z *= -1;
            }
            particles.geometry.attributes.position.needsUpdate = true;
          }

          renderer.render(scene, camera);
        }

        animate();

      } catch (err) {
        console.error("Init Error:", err);
        setStatus(`Error: ${err.message}`);
      }
    }

    // Helper for terrain height that matches geometry generation
    function getTerrainHeight(x, z) {
      return Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
             Math.sin(x * 0.1) * Math.cos(z * 0.1) * 1.5 +
             Math.sin(x * 0.2) * Math.cos(z * 0.2) * 0.5;
    }

    function handleResize() {
      if (!containerRef.current || !rendererRef.current) return;
      const width = containerRef.current.offsetWidth;
      const height = containerRef.current.offsetHeight;
      
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    }

    init();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (cleanupClick) cleanupClick();
      if (animationId) cancelAnimationFrame(animationId);
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      if (sceneRef.current) {
        // basic cleanup
        sceneRef.current.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
            else o.material.dispose();
          }
        });
      }
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, []);

  return html`
    <div className="w-full h-screen bg-black relative overflow-hidden font-sans select-none">
      <div ref=${containerRef} className="w-full h-full" />
      
      ${status !== 'rendering' && html`
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 backdrop-blur-sm z-50">
          <div className="text-center text-white p-8">
            <${Loader2} className="w-12 h-12 mx-auto mb-4 text-blue-400 animate-spin" />
            <h2 className="text-2xl font-bold mb-2">Loading Scene</h2>
            <p className="text-gray-400 font-mono text-sm">${status}</p>
          </div>
        </div>
      `}

      ${status === 'rendering' && html`
        <${React.Fragment}>
          <div className="absolute top-4 left-4 pointer-events-none">
            <div className="bg-black/60 backdrop-blur-md text-white p-4 rounded-xl border border-white/10 shadow-xl">
              <h2 className="text-lg font-bold mb-2 flex items-center gap-2">
                <${Sparkles} className="w-4 h-4 text-yellow-400" />
                Interactive Terrain
              </h2>
              <div className="space-y-1 text-xs text-gray-300">
                <div className="flex items-center gap-2">
                  <${MousePointer2} className="w-3 h-3 text-blue-400" />
                  <span>Click ground to move</span>
                </div>
                <div className="flex items-center gap-2">
                  <${Wind} className="w-3 h-3 text-green-400" />
                  <span>Procedural Vegetation</span>
                </div>
                <div className="pt-2 mt-2 border-t border-white/10 flex justify-between font-mono text-[10px] opacity-70">
                  <span>${stats.fps} FPS</span>
                  <span>${(stats.triangles / 1000).toFixed(1)}k Tris</span>
                </div>
              </div>
            </div>
          </div>
        </${React.Fragment}>
      `}
    </div>
  `;
}

