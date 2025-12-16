import * as THREE from 'three';

export class GrassSystem {
  constructor(scene, getTerrainHeight) {
    this.uniforms = { 
      uTime: { value: 0 }, 
      uPlayerPos: { value: new THREE.Vector3(0, -100, 0) } 
    };
    
    this.mesh = this.createGrassMesh(getTerrainHeight);
    scene.add(this.mesh);
  }

  createGrassMesh(getTerrainHeight) {
    const grassHeight = 0.35;
    const grassGeo = new THREE.PlaneGeometry(0.1, grassHeight, 1, 2);
    grassGeo.translate(0, grassHeight / 2, 0); 
    
    const posAttribute = grassGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
      const y = posAttribute.getY(i);
      const taper = 1.0 - (y / grassHeight); 
      const x = posAttribute.getX(i);
      posAttribute.setX(i, x * taper); 
    }
    grassGeo.computeVertexNormals();

    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, 
      roughness: 0.6,
      metalness: 0.1,
      side: THREE.DoubleSide,
      onBeforeCompile: (shader) => {
        shader.uniforms.uTime = this.uniforms.uTime;
        shader.uniforms.uPlayerPos = this.uniforms.uPlayerPos;
        
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
          
          vec4 instanceWorldPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          instanceWorldPos = modelMatrix * instanceWorldPos;
          
          float hRatio = position.y / ${grassHeight.toFixed(2)};
          float bendSensitivity = pow(hRatio, 2.0);

          float windFreq = uTime * 1.5;
          float sway = sin(windFreq + instanceWorldPos.x * 0.5) * 0.5 + 
                       sin(windFreq * 1.2 + instanceWorldPos.z * 0.4) * 0.3 + 
                       sin(windFreq * 0.5 + instanceWorldPos.x * 0.2 + instanceWorldPos.z * 0.2) * 0.2;
          
          transformed.x += sway * 0.15 * bendSensitivity;
          transformed.z += sway * 0.05 * bendSensitivity;
          
          float dist = distance(instanceWorldPos.xz, uPlayerPos.xz);
          float radius = 0.8; 
          
          if(dist < radius){
             float interaction = 1.0 - (dist / radius);
             interaction = smoothstep(0.0, 1.0, interaction);
             vec2 pushDir = normalize(instanceWorldPos.xz - uPlayerPos.xz);
             float pushStrength = 1.0 * interaction;
             transformed.x += pushDir.x * pushStrength * bendSensitivity;
             transformed.z += pushDir.y * pushStrength * bendSensitivity;
             transformed.y *= 1.0 - (interaction * 0.8 * bendSensitivity);
          }
          `
        );

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
    
    const grassCount = 2000000;
    const mesh = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
    mesh.castShadow = false; 
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; 

    const dummy = new THREE.Object3D();
    for (let i = 0; i < grassCount; i++) {
      const x = (Math.random() - 0.5) * 200; 
      const z = (Math.random() - 0.5) * 200;
      const y = getTerrainHeight(x, z);
      
      dummy.position.set(x, y, z);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      const scale = 0.6 + Math.random() * 0.4;
      dummy.scale.set(scale, scale, scale);
      
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    
    return mesh;
  }

  update(time, playerPosition) {
    this.uniforms.uTime.value = time;
    if (playerPosition) {
      this.uniforms.uPlayerPos.value.copy(playerPosition);
    }
  }
}

