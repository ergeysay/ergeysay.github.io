// Standalone WebGL wave renderer (factored out of the makemeheard site).
//
// Loads a skinned glTF (wave.glb) - exported from the Blender bone rig that
// bones.py builds from data.json - and plays its baked animation with a custom
// glass shader (refraction + dispersion over an animated procedural backdrop).
// The .glb is uncompressed, so no Draco decoder / worker / wasm is needed.
//
// Asset paths are relative to this folder, so the whole webgl/ directory is
// self-contained. Serve it over http (module imports + worker + wasm won't run
// from file://).

import {
  Renderer,
  Camera,
  Transform,
  GLTFLoader,
  Program,
  Mesh,
  Triangle,
  Vec2,
  Vec3,
} from "./ogl.js";

// Procedural background, shared (as a GLSL snippet) by the fullscreen backdrop
// and the glass refraction so they sample the exact same image. A coloured
// gradient with a faint checker mixed in - the checker makes the refraction /
// dispersion distortion legible without dominating the look.
const BG_CELLS = 24.0;  // checker squares across the screen
// Blob centres (uBlob0..2) are animated on the CPU and passed in as uniforms,
// so there's no per-fragment trig - cheap, and identical to computing it here.
const BG_GLSL = `
  uniform vec2 uBlob0;
  uniform vec2 uBlob1;
  uniform vec2 uBlob2;
  vec3 background(vec2 uv) {
    vec3 col = mix(vec3(0.04, 0.06, 0.11), vec3(0.10, 0.16, 0.28), uv.y);
    col += vec3(0.10, 0.55, 0.40) * smoothstep(0.55, 0.0, distance(uv, uBlob0));
    col += vec3(0.65, 0.18, 0.22) * smoothstep(0.50, 0.0, distance(uv, uBlob1));
    col += vec3(0.20, 0.30, 0.55) * smoothstep(0.40, 0.0, distance(uv, uBlob2));
    vec2 c = floor(uv * ${BG_CELLS.toFixed(1)});
    float checker = mod(c.x + c.y, 2.0);
    col += (checker - 0.5) * 0.0;   // faint +/-0.025 checker overlay (temporarily off)
    return col;
  }
`;

const MOUNT = "#hero__wave";          // container element to render into
const GLTF_URL = "./temp.glb";        // TEMP: new rig (revert to ./wave.glb)
const ANIM_SPEED = 1 / 900;           // animation seconds advanced per ms of wall time
const FPS = 60;

// audio spectrum (data.json from generate.py) drives reactive visuals
const SPECTRUM_URL = "./data.json";
const SPECTRUM_FPS = 120;             // data.json was baked at 120 fps
// mean band energy only spans ~0.03..0.22, so remap that window to a full 0..1
const AUDIO_FLOOR = 0.03;
const AUDIO_CEIL = 0.20;
const AUDIO_SMOOTH = 0.4;             // EMA factor (higher = snappier)

// Loads data.json and exposes the live audio level. `level` is a smoothed [0,1]
// loudness; `bands` is the raw per-band array for the current frame (kept around
// because we'll drive more things off individual bands later).
function createAudioSource() {
  const state = { frames: null, level: 0, bands: null, start: Date.now() };
  fetch(SPECTRUM_URL)
    .then((r) => r.json())
    .then((d) => { state.frames = Object.keys(d).sort((a, b) => a - b).map((k) => d[k]); })
    .catch(() => {}); // no data.json -> stays silent, visuals just don't react

  state.sample = () => {
    if (!state.frames) return 0;
    const dur = state.frames.length / SPECTRUM_FPS;
    const t = ((Date.now() - state.start) / 1000) % dur;
    const f = Math.min(state.frames.length - 1, Math.floor(t * SPECTRUM_FPS));
    const bands = state.frames[f];
    let sum = 0;
    for (let i = 0; i < bands.length; i++) sum += bands[i];
    const mean = sum / bands.length;
    const energy = Math.min(1, Math.max(0, (mean - AUDIO_FLOOR) / (AUDIO_CEIL - AUDIO_FLOOR)));
    state.level += (energy - state.level) * AUDIO_SMOOTH;
    state.bands = bands;
    return state.level;
  };
  return state;
}

export function initWaveRenderer() {
  const renderer = new Renderer({ alpha: true });
  const element = document.querySelector(MOUNT);
  const gl = renderer.gl;
  element.appendChild(gl.canvas);

  const camera = new Camera(gl);
  camera.position.z = 40;
  camera.lookAt(new Vec3(0, 0, 0));

  const scene = new Transform();

  // two coloured lights (mint + red) for the tint and glints
  const uLightPosition0 = { value: new Vec3(10.0, -5.0, -3.0) };
  const uLightPosition1 = { value: new Vec3(-10.0, 5.0, -3.0) };
  const uLightColor0 = { value: new Vec3(10.0 / 256, 240.0 / 256, 176.0 / 256) };
  const uLightColor1 = { value: new Vec3(221 / 256, 61 / 256, 39 / 256) };

  const uAudio = { value: 0 };
  const uExposure = { value: 1.0 };  // 1.0 = original brightness
  const uBlob0 = { value: new Vec2() };  // animated background blob centres
  const uBlob1 = { value: new Vec2() };
  const uBlob2 = { value: new Vec2() };
  let time = 0;                      // seconds, drives the background drift
  const audio = createAudioSource();

  // fullscreen backdrop - draws the shared background gradient behind the glass
  const backdrop = new Mesh(gl, {
    geometry: new Triangle(gl),
    program: new Program(gl, {
      vertex: `
        attribute vec2 uv;
        attribute vec2 position;
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }
      `,
      fragment: `
        precision highp float;
        varying vec2 vUv;
        ${BG_GLSL}
        void main() { gl_FragColor = vec4(background(vUv), 1.0); }
      `,
      uniforms: { uBlob0, uBlob1, uBlob2 },
      depthTest: false,
      depthWrite: false,
    }),
  });

  let gltf;

  function resize() {
    renderer.setSize(element.clientWidth, element.clientHeight);
    camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
  }
  window.addEventListener("resize", resize, false);
  resize();

  const program = new Program(gl, {
    vertex: `
      attribute vec2 uv;
      attribute vec3 position;
      attribute vec3 normal;
      attribute vec4 skinIndex;
      attribute vec4 skinWeight;

      uniform mat4 modelViewMatrix;
      uniform mat4 modelMatrix;
      uniform mat4 projectionMatrix;
      uniform mat3 normalMatrix;
      uniform vec3 uCameraPosition;
      uniform sampler2D boneTexture;
      uniform int boneTextureSize;

      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vPosition;
      varying vec2 vScreenUV;

      mat4 getBoneMatrix(const in float i) {
        float j = i * 4.0;
        float x = mod(j, float(boneTextureSize));
        float y = floor(j / float(boneTextureSize));
        float dx = 1.0 / float(boneTextureSize);
        float dy = 1.0 / float(boneTextureSize);
        y = dy * (y + 0.5);
        vec4 v1 = texture2D(boneTexture, vec2(dx * (x + 0.5), y));
        vec4 v2 = texture2D(boneTexture, vec2(dx * (x + 1.5), y));
        vec4 v3 = texture2D(boneTexture, vec2(dx * (x + 2.5), y));
        vec4 v4 = texture2D(boneTexture, vec2(dx * (x + 3.5), y));
        return mat4(v1, v2, v3, v4);
      }

      void skin(inout vec4 pos, inout vec3 nml) {
        mat4 boneMatX = getBoneMatrix(skinIndex.x);
        mat4 boneMatY = getBoneMatrix(skinIndex.y);
        mat4 boneMatZ = getBoneMatrix(skinIndex.z);
        mat4 boneMatW = getBoneMatrix(skinIndex.w);

        mat4 skinMatrix = mat4(0.0);
        skinMatrix += skinWeight.x * boneMatX;
        skinMatrix += skinWeight.y * boneMatY;
        skinMatrix += skinWeight.z * boneMatZ;
        skinMatrix += skinWeight.w * boneMatW;
        // a bone scaled to 0 zeros the skinned normal -> normalize(0) = NaN ->
        // black. Fall back to the rest normal (direction is unchanged by uniform
        // scale anyway) when the skinned normal degenerates.
        vec3 skinnedNormal = vec4(skinMatrix * vec4(nml, 0.0)).xyz;
        nml = dot(skinnedNormal, skinnedNormal) > 1e-8 ? skinnedNormal : nml;

        vec4 transformed = vec4(0.0);
        transformed += boneMatX * pos * skinWeight.x;
        transformed += boneMatY * pos * skinWeight.y;
        transformed += boneMatZ * pos * skinWeight.z;
        transformed += boneMatW * pos * skinWeight.w;
        pos = transformed;
      }

      void main() {
        vec4 pos = vec4(position, 1);
        vec3 nml = normal;
        skin(pos, nml);

        vUv = uv;
        vNormal = normalize(nml);
        vViewDir = uCameraPosition - (modelMatrix * pos).xyz;
        vPosition = pos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * pos;
        vScreenUV = (gl_Position.xy / gl_Position.w) * 0.5 + 0.5;
      }
    `,
    fragment: `
      precision highp float;

      uniform vec3 uCameraPosition;
      uniform vec3 uLightPosition0;
      uniform vec3 uLightPosition1;
      uniform vec3 uLightColor0;
      uniform vec3 uLightColor1;
      uniform float uAudio;       // smoothed audio level in [0,1]
      uniform float uExposure;    // overall brightness

      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec3 vViewDir;
      varying vec2 vScreenUV;
      ${BG_GLSL}

      float saturate(float v) { return clamp(v, 0.0, 1.0); }

      // half-lambert (Valve): the squared falloff restores the rounded, non-flat
      // shaping the SH wrap diffuse had, for a fraction of the cost.
      float wrapDiffuse(vec3 N, vec3 L) {
        float h = saturate(dot(N, L) * 0.5 + 0.5);
        return h * h;
      }

      // sharp reflected highlight of one light (glassy glint)
      vec3 glint(vec3 R, vec3 P, vec3 lightPos, vec3 lightCol, float gloss) {
        return lightCol * pow(saturate(dot(R, normalize(lightPos - P))), gloss);
      }

      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        vec3 R = reflect(-V, N);
        float fres = pow(1.0 - saturate(dot(N, V)), 3.0);

        // REFRACTION: sample the background offset by the surface normal, with a
        // The glass samples the backdrop in screen space: refraction through the
        // body (offset by the surface normal) and reflection at grazing edges
        // (offset by the reflect vector), blended by fresnel into one sample point.
        vec2 refrUV = vScreenUV + N.xy * (0.18 + uAudio * 0.22);
        vec2 reflUV = vScreenUV + R.xy * 0.30;
        vec2 glassUV = mix(refrUV, reflUV, fres);

        vec3 glassCol = background(glassUV);

        // subtle coloured tint from the two side lights (keeps the brand colours)
        vec3 tint =
          uLightColor0 * wrapDiffuse(N, normalize(uLightPosition0 - vPosition)) +
          uLightColor1 * wrapDiffuse(N, normalize(uLightPosition1 - vPosition));

        // crisp glints off the side lights
        float gloss = mix(120.0, 500.0, uAudio);
        vec3 glints =
          glint(R, vPosition, uLightPosition0, uLightColor0, gloss) +
          glint(R, vPosition, uLightPosition1, uLightColor1, gloss);

        // extra specular lights placed around the object for more highlights.
        // sharp lobe (glass needs crisp glints, not a broad matte sheen) - they
        // catch as the surface moves because there are several of them.
        vec3 spec = vec3(0.85, 0.90, 1.0) * 1.3;  // cool white
        float specGloss = 90.0;
        glints +=
          glint(R, vPosition, vec3(  0.0,  15.0,  8.0), spec, specGloss) +
          glint(R, vPosition, vec3(  0.0, -15.0,  8.0), spec, specGloss) +
          glint(R, vPosition, vec3( 20.0,   8.0,  5.0), spec, specGloss) +
          glint(R, vPosition, vec3(-20.0,  -8.0,  5.0), spec, specGloss) +
          glint(R, vPosition, vec3( 12.0, -12.0,  6.0), spec, specGloss) +
          glint(R, vPosition, vec3(-12.0,  12.0,  6.0), spec, specGloss);

        // fresnel rim glow on the glassy edges
        vec3 rim = mix(uLightColor0, uLightColor1, 0.5) * fres;

        // glass = refraction through the body, reflection at the edges, + tint + glints + rim
        vec3 color = glassCol + tint * 0.25 + glints + rim * 0.27;
        color += glints * (uAudio * 2.0);   // audio accent

        gl_FragColor = vec4(color * uExposure, 1.0);
      }
    `,
    uniforms: {
      uLightPosition0, uLightPosition1,
      uLightColor0, uLightColor1,
      uCameraPosition: camera.position,
      uAudio,
      uExposure,
      uBlob0, uBlob1, uBlob2,
    },
    depthTest: true,
    depthWrite: true,       // opaque: refraction provides the see-through, depth resolves self-intersections
    cullFace: gl.BACK,
  });

  async function loadGltf() {
    gltf = await GLTFLoader.load(gl, GLTF_URL);
    const s = gltf.scene || gltf.scenes[0];
    s.forEach((root) => {
      root.setParent(scene);
      root.traverse((node) => {
        if (!node.program) return;
        // our shader skins the mesh, so only attach it to skinned geometry;
        // drop any stray non-skinned meshes (e.g. a leftover Cube in the export)
        if (node.geometry && node.geometry.attributes.skinIndex) {
          node.program = program;
        } else {
          node.setParent(null);
        }
      });
    });
    scene.updateMatrixWorld();
  }
  loadGltf();

  renderer.autoClear = false; // we clear once, then draw backdrop + glass in order

  let then = Date.now();
  const interval = 1000 / FPS;
  function update() {
    requestAnimationFrame(update);
    const now = Date.now();
    const delta = now - then;
    if (delta < interval) return;
    then = now - (delta % interval);

    uAudio.value = 0.0;   // audio reactivity disabled (audio source kept for later)

    // advance time and drift the background blobs (computed here, not per-fragment)
    time += delta * 0.001 / 3.0;
    uBlob0.value.set(0.42 + 0.22 * Math.sin(time * 0.5),  0.58 + 0.22 * Math.cos(time * 0.37));
    uBlob1.value.set(0.60 + 0.22 * Math.cos(time * 0.43), 0.44 + 0.22 * Math.sin(time * 0.31));
    uBlob2.value.set(0.58 + 0.22 * Math.sin(time * 0.29), 0.60 + 0.22 * Math.cos(time * 0.47));

    if (gltf && gltf.animations && gltf.animations.length) {
      const { animation } = gltf.animations[0];
      animation.elapsed += delta * ANIM_SPEED;
      animation.update();
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    renderer.render({ scene: backdrop, camera });  // background first
    renderer.render({ scene, camera });            // glass refracts it
  }
  requestAnimationFrame(update);

  return { audio, uAudio, uExposure }; // exposed so callers can read the level / drive more
}

// expose on window for quick experimentation later
window.waveRenderer = initWaveRenderer();
