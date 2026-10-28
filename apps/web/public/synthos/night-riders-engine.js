import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const roadRoles = [
  { id: "lead", accent: "#00ead7" },
  { id: "search", accent: "#ff4db8" },
  { id: "grep", accent: "#b266ff" },
  { id: "docs", accent: "#ffc94d" },
];

export function mountNightRiders(host, initialState, onSelect, onAvailability) {
  let state = initialState;
  let disposed = false;
  let lost = false;
  let inView = false;
  let frame = 0;
  let previous = 0;
  let clock = 0;
  let renderer;
  let scene;
  let camera;
  let world;
  let resizeObserver;
  let intersectionObserver;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const listeners = new AbortController();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const listen = (target, type, callback) =>
    target.addEventListener(type, callback, { signal: listeners.signal });
  function collectResources() {
    scene?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
  }
  function render() {
    if (!disposed && !lost && inView && !document.hidden) renderer?.render(scene, camera);
  }
  function canAnimate() {
    return (
      !disposed &&
      !lost &&
      inView &&
      !document.hidden &&
      !media.matches &&
      !state.paused &&
      state.moving
    );
  }
  function schedule() {
    if (!canAnimate()) {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      return;
    }
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function tick(time) {
    frame = 0;
    if (!canAnimate()) {
      previous = 0;
      return;
    }
    // Rendering is capped at 30 fps even on high-refresh displays.
    if (!previous || time - previous >= 1000 / 30) {
      clock += previous ? Math.min((time - previous) / 1000, 0.1) : 0;
      previous = time;
      world.update(state, clock);
      render();
    }
    frame = requestAnimationFrame(tick);
  }
  function setCamera() {
    if (!camera) return;
    const positions = [
      [0, 5.2, 13],
      [10, 6.3, 12],
      [-10, 4.5, 10],
    ];
    camera.position.fromArray(positions[state.camera] || positions[0]);
    if (camera.aspect < 1.6) {
      camera.position.multiplyScalar(1.4);
      camera.lookAt(-0.5, 1, -1);
    } else camera.lookAt(0, 1.2, -8);
  }
  function update(next = state) {
    state = next;
    if (disposed) return;
    setCamera();
    world?.update(state, clock);
    render();
    schedule();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    intersectionObserver?.disconnect();
    resizeObserver?.disconnect();
    listeners.abort();
    collectResources();
    for (const texture of textures) texture.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
  }
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%;";
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.append(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#090c23");
    scene.fog = new THREE.FogExp2("#100d29", 0.0085);
    camera = new THREE.PerspectiveCamera(48, 2.5, 0.1, 250);
    world = buildWorld(scene);
    collectResources();
    void world.loadAssets(
      () => !disposed,
      () => {
        collectResources();
        update();
      },
    );
    const resize = () => {
      if (!host.clientWidth || !host.clientHeight || disposed) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      update();
    };
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? false;
        update();
      },
      { rootMargin: "40px" },
    );
    intersectionObserver.observe(host);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    listen(renderer.domElement, "pointerup", (event) => {
      if (event.button !== 0 || lost || disposed) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      for (const hit of raycaster.intersectObjects(world.hitTargets, true)) {
        let object = hit.object;
        while (object && !object.userData.role) object = object.parent;
        if (object?.userData.role) {
          onSelect(object.userData.role);
          break;
        }
      }
    });
    listen(renderer.domElement, "webglcontextlost", (event) => {
      event.preventDefault();
      lost = true;
      onAvailability(false);
      update();
    });
    listen(renderer.domElement, "webglcontextrestored", () => {
      lost = false;
      onAvailability(true);
      resize();
    });
    listen(document, "visibilitychange", () => update());
    listen(media, "change", () => update());
    resize();
    onAvailability(true);
  } catch {
    dispose();
    onAvailability(false);
  }
  return { update, dispose };
}
function buildWorld(scene) {
  const palette = {
    white: "#e4e8ee",
    dark: "#091123",
    cyan: "#00ead7",
    pink: "#ff4db8",
    violet: "#b266ff",
    amber: "#ffc94d",
  };
  const metal = (color, roughness = 0.36, metalness = 0.5) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const ink = metal(palette.dark),
    white = metal(palette.white, 0.24, 0.45),
    chrome = metal("#b9d6ee", 0.2, 0.85),
    rubber = metal("#060912", 0.85, 0);
  const glow = (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const cyan = glow(palette.cyan),
    pink = glow(palette.pink),
    glass = metal("#15384d", 0.12, 0.75);
  const box = (parent, material, size, position, rotation) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.fromArray(position);
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
  };
  const line = (parent, points, color, opacity = 1) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(
      points.map((point) => new THREE.Vector3(...point)),
    );
    const mesh = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
    );
    parent.add(mesh);
    return mesh;
  };
  const edges = (mesh, color, opacity = 0.7) => {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    mesh.add(outline);
  };
  scene.add(new THREE.HemisphereLight("#b1b9ff", "#1c0b31", 2.1));
  const key = new THREE.DirectionalLight("#b5eeff", 3.5);
  key.position.set(-5, 10, 8);
  scene.add(key);
  for (const [color, x] of [
    [palette.pink, -7],
    [palette.cyan, 7],
  ]) {
    const light = new THREE.PointLight(color, 75, 30, 2);
    light.position.set(x, 3, 2);
    scene.add(light);
  }
  box(scene, metal("#080b1a", 0.3, 0.55), [17, 0.15, 185], [0, -0.13, -65]);
  box(scene, metal("#0d1030", 0.9, 0), [220, 0.1, 200], [0, -0.22, -65]);
  const grid = new THREE.GridHelper(200, 80, "#672155", "#322452");
  grid.position.set(0, -0.1, -65);
  scene.add(grid);
  for (const x of [-8.2, 8.2]) {
    box(scene, cyan, [0.055, 0.025, 180], [x, 0.01, -65]);
    box(scene, pink, [0.055, 0.025, 180], [x * 1.04, 0.01, -65]);
    box(scene, metal("#253047"), [0.18, 0.18, 180], [x * 1.09, 0.4, -65]);
  }
  const road = new THREE.Group();
  scene.add(road);
  for (let z = -140; z < 18; z += 5) {
    for (const x of [-2.8, 2.8]) box(road, glow("#6689aa"), [0.045, 0.012, 1.3], [x, 0.015, z]);
    box(road, glow("#5b214c"), [16, 0.012, 0.025], [0, 0.018, z]);
  }
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 48),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader:
        "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "varying vec2 vUv;void main(){vec2 p=vUv-.5; if(length(p)>.49)discard; if(vUv.y<.48&&mod(vUv.y*22.,1.)<.34)discard;vec3 color=mix(vec3(1.,.055,.48),vec3(1.,.66,.2),vUv.y);gl_FragColor=vec4(color,.94);}",
    }),
  );
  sun.position.set(0, 25, -150);
  scene.add(sun);
  // Deterministic city: no network textures or random state changes during rendering.
  let seed = 87;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const windowMatrices = [],
    windowColors = [];
  for (let i = 0; i < 52; i++) {
    const side = i % 2 ? 1 : -1,
      z = -12 - Math.floor(i / 2) * 5.6,
      x = side * (12 + random() * 26),
      height = 4 + random() * 24,
      width = 2 + random() * 4;
    const building = box(
      scene,
      metal(i % 3 ? "#10112d" : "#19132f", 0.55, 0.3),
      [width, height, 3 + random() * 3],
      [x, height / 2 - 0.1, z],
    );
    edges(building, i % 3 ? "#397487" : "#9d287a", 0.65);
    box(scene, i % 2 ? pink : cyan, [width + 0.08, 0.09, 0.12], [x, height, z + 2.1]);
    for (let y = 1; y < height - 1; y += 1.4)
      for (let column = -width / 2 + 0.5; column < width / 2; column += 0.8) {
        if (random() > 0.58) continue;
        const matrix = new THREE.Matrix4().makeTranslation(
          x + column,
          y,
          z + building.geometry.parameters.depth / 2 + 0.015,
        );
        windowMatrices.push(matrix);
        windowColors.push(new THREE.Color(random() > 0.4 ? "#187389" : "#9c297b"));
      }
  }
  const windows = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.18, 0.48),
    glow("#ffffff"),
    windowMatrices.length,
  );
  windowMatrices.forEach((matrix, i) => {
    windows.setMatrixAt(i, matrix);
    windows.setColorAt(i, windowColors[i]);
  });
  scene.add(windows);
  // Mountains, palm silhouettes, and arcade gantry frame the road without hiding vehicles.
  for (const side of [-1, 1]) {
    const mountain = new THREE.Mesh(new THREE.ConeGeometry(24, 30, 5), metal("#151333"));
    mountain.position.set(side * 46, 10, -105);
    mountain.rotation.y = 0.4;
    scene.add(mountain);
    edges(mountain, "#70429e", 0.65);
    for (const z of [-8, -27, -50]) {
      const x = side * 10.5,
        height = 8 + Math.abs(z) * 0.035;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.27, height, 7),
        metal("#12152b"),
      );
      trunk.position.set(x, height / 2, z);
      trunk.rotation.z = -side * 0.09;
      scene.add(trunk);
      for (let leaf = 0; leaf < 7; leaf++) {
        const angle = (leaf / 7) * Math.PI * 2;
        const points = [
          [x - side * 0.6, height, z],
          [x + Math.cos(angle) * 1.5, height + 0.5, z + Math.sin(angle) * 1.5],
          [x + Math.cos(angle) * 3.4, height - 0.6, z + Math.sin(angle) * 3.4],
        ];
        line(scene, points, leaf % 2 ? "#4a2964" : "#186773");
        for (let n = 1; n <= 4; n++) {
          const amount = n / 5,
            px = x + Math.cos(angle) * 3 * amount,
            pz = z + Math.sin(angle) * 3 * amount,
            py = height + 0.5 - amount;
          line(
            scene,
            [
              [px + Math.sin(angle) * 0.7, py - 0.6, pz - Math.cos(angle) * 0.7],
              [px, py, pz],
              [px - Math.sin(angle) * 0.7, py - 0.6, pz + Math.cos(angle) * 0.7],
            ],
            "#214b63",
          );
        }
      }
    }
  }
  for (const x of [-8.8, 8.8]) {
    box(scene, chrome, [0.2, 6, 0.2], [x, 3, -35]);
    box(scene, pink, [0.05, 5.8, 0.04], [x + 0.15, 3, -34.85]);
  }
  box(scene, ink, [18.3, 0.5, 0.35], [0, 6, -35]);
  box(scene, cyan, [18, 0.035, 0.04], [0, 5.85, -34.8]);
  const hitTargets = [],
    vehicles = new Map();
  function wheel(parent, x, z, radius, width) {
    const group = new THREE.Group();
    group.position.set(x, radius, z);
    parent.add(group);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), rubber);
    tire.rotation.z = Math.PI / 2;
    group.add(tire);
    for (const side of [-1, 1]) {
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, 0.025, 12),
        chrome,
      );
      hub.rotation.z = Math.PI / 2;
      hub.position.x = (side * width) / 2;
      group.add(hub);
      for (let spoke = 0; spoke < 5; spoke++) {
        const angle = (spoke / 5) * Math.PI * 2;
        const bar = box(
          group,
          ink,
          [0.035, radius * 1.1, 0.055],
          [side * (width / 2 + 0.025), 0, 0],
        );
        bar.rotation.x = angle;
      }
    }
    return group;
  }
  function wedge(parent, material, width, length, frontHeight, backHeight, y = 0.35) {
    const w = width / 2,
      l = length / 2;
    const points = [
      -w,
      y,
      -l,
      w,
      y,
      -l,
      w,
      y,
      l,
      -w,
      y,
      l,
      -w,
      y + frontHeight,
      -l,
      w,
      y + frontHeight,
      -l,
      w,
      y + backHeight,
      l,
      -w,
      y + backHeight,
      l,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const indices = [
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 3,
      2, 1, 3, 1, 0,
    ];
    for (let i = 0; i < indices.length; i += 3)
      [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  }
  function register(id, group, lamps, wheels, position) {
    group.userData.role = id;
    group.position.fromArray(position);
    scene.add(group);
    hitTargets.push(group);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(id === "lead" ? 2.6 : 1.25, id === "lead" ? 2.64 : 1.29, 64),
      new THREE.MeshBasicMaterial({
        color: "#b9d6ee",
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    group.add(ring);
    vehicles.set(id, { group, lamps: [lamps], wheels, ring, origin: position.slice() });
  }
  const car = new THREE.Group();
  wedge(car, white, 2.8, 4.7, 0.24, 0.53, 0.37);
  box(car, ink, [2.84, 0.12, 4.75], [0, 0.38, 0]);
  box(car, white, [2.55, 0.12, 1.7], [0, 0.91, 1.35]);
  const cabin = wedge(car, glass, 2.1, 1.8, 0.6, 0.6, 0.79);
  cabin.position.z = -0.05;
  edges(cabin, "#d4e7f0");
  box(car, white, [2.16, 0.09, 0.92], [0, 1.4, 0.05]);
  // Windshield rake and flying-buttress silhouette.
  box(car, glass, [2.08, 0.72, 0.04], [0, 1.08, -0.91], [-0.55, 0, 0]);
  for (const side of [-1, 1]) {
    box(car, white, [0.1, 0.75, 0.1], [side * 1.08, 1.06, -0.87], [-0.55, 0, 0]);
    box(car, white, [0.18, 0.3, 1.45], [side * 1.13, 1.06, 0.93], [0.1, 0, side * 0.1]);
    box(car, white, [0.28, 0.15, 0.32], [side * 1.57, 0.97, -0.68]);
    for (let slat = 0; slat < 5; slat++)
      box(car, ink, [0.035, 0.035, 1.75], [side * 1.42, 0.53 + slat * 0.065, 0.55]);
    box(car, chrome, [0.02, 0.025, 3.8], [side * 1.43, 0.85, 0.2]);
  }
  for (let slat = 0; slat < 8; slat++)
    box(car, ink, [1.83, 0.035, 0.055], [0, 0.99, 0.72 + slat * 0.13]);
  box(car, ink, [2.57, 0.28, 0.045], [0, 0.72, 2.39]);
  const tailMaterial = new THREE.MeshStandardMaterial({
    color: "#592541",
    emissive: "#ff246f",
    emissiveIntensity: 0.1,
  });
  for (const x of [-0.91, 0.91])
    for (let stripe = 0; stripe < 3; stripe++)
      box(car, tailMaterial, [0.62, 0.028, 0.035], [x, 0.65 + stripe * 0.075, 2.43]);
  box(car, chrome, [0.66, 0.2, 0.02], [0, 0.52, 2.43]);
  box(car, ink, [0.51, 0.12, 0.025], [0, 0.52, 2.45]);
  for (const x of [-1.05, 1.05]) {
    box(car, ink, [0.3, 0.12, 0.2], [x, 0.28, 2.43]);
    box(car, glow("#a8cbd9"), [0.67, 0.045, 0.035], [x * 0.85, 0.63, -2.37]);
  }
  const carWheels = [];
  for (const x of [-1.37, 1.37])
    for (const z of [-1.4, 1.45]) carWheels.push(wheel(car, x, z, 0.46, 0.32));
  register("lead", car, tailMaterial, carWheels, [0, 0, 2]);
  for (const [index, role] of roadRoles.slice(1).entries()) {
    const bike = new THREE.Group(),
      paint = metal(role.accent, 0.3, 0.6),
      accent = glow(role.accent);
    const wheels = [-0.85, 0.85].map((z) => wheel(bike, 0, z, 0.45, 0.27));
    wedge(bike, paint, 0.56, 1.4, 0.3, 0.12, 0.65);
    box(bike, ink, [0.43, 0.16, 0.65], [0, 0.95, 0.32]);
    box(bike, paint, [0.48, 0.58, 0.3], [0, 1.03, -0.65], [-0.25, 0, 0]);
    box(bike, glass, [0.43, 0.33, 0.035], [0, 1.36, -0.76], [-0.3, 0, 0]);
    for (const side of [-1, 1]) {
      box(bike, chrome, [0.055, 0.95, 0.055], [side * 0.18, 0.85, -0.71], [-0.2, 0, 0]);
      line(
        bike,
        [
          [side * 0.15, 0.46, 0.85],
          [side * 0.23, 0.86, -0.1],
          [side * 0.13, 0.46, -0.85],
        ],
        role.accent,
      );
      box(bike, chrome, [0.1, 0.1, 0.65], [side * 0.28, 0.47, 0.65]);
    }
    box(bike, chrome, [0.84, 0.05, 0.06], [0, 1.34, -0.45]);
    // Compact armored rider, leaning over the tank; no floating dashboard avatars.
    const armor = metal("#19223b", 0.38, 0.55);
    const torso = box(bike, armor, [0.49, 0.62, 0.34], [0, 1.42, 0.1], [-0.55, 0, 0]);
    edges(torso, role.accent, 0.7);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), armor);
    helmet.position.set(0, 1.8, -0.19);
    bike.add(helmet);
    box(bike, accent, [0.34, 0.085, 0.035], [0, 1.81, -0.405]);
    for (const side of [-1, 1]) {
      box(bike, armor, [0.16, 0.53, 0.16], [side * 0.31, 1.3, -0.15], [-0.9, 0, side * -0.2]);
      box(bike, armor, [0.17, 0.48, 0.2], [side * 0.3, 0.83, 0.3], [-0.5, 0, side * 0.1]);
    }
    const lamp = new THREE.MeshStandardMaterial({
      color: "#55273e",
      emissive: role.accent,
      emissiveIntensity: 0.08,
    });
    box(bike, lamp, [0.35, 0.065, 0.04], [0, 1.04, 0.74]);
    const locations = [
      [-3.5, 0, -1.8],
      [3.7, 0, 0.1],
      [-5.5, 0, 2.5],
    ];
    register(role.id, bike, lamp, wheels, locations[index]);
  }
  return {
    hitTargets,
    async loadAssets(alive, onChange) {
      const loader = new GLTFLoader();
      const results = await Promise.allSettled([
        loader.loadAsync(new URL("./vehicles/car.glb", import.meta.url).href),
        loader.loadAsync(new URL("./vehicles/motorcycle.glb", import.meta.url).href),
      ]);
      if (!alive()) {
        for (const result of results)
          if (result.status === "fulfilled")
            result.value.scene.traverse((object) => {
              object.geometry?.dispose();
              if (Array.isArray(object.material))
                object.material.forEach((material) => material.dispose());
              else object.material?.dispose();
            });
        return;
      }
      for (const role of roadRoles) {
        const result = results[role.id === "lead" ? 0 : 1];
        if (result.status !== "fulfilled") continue; // Locally authored geometry remains usable offline if an asset is missing.
        const vehicle = vehicles.get(role.id),
          imported = result.value.scene.clone(true),
          lights = [],
          wheels = [];
        imported.rotation.y = Math.PI;
        imported.traverse((object) => {
          if (object.material) {
            const original = object.material;
            object.material = original.clone();
            if (original.name === "vehicle-accent") object.material.color.set(role.accent);
            if (original.name === "vehicle-glow") {
              object.material.emissive.set(role.accent);
              object.material.emissiveIntensity = 0.08;
              lights.push(object.material);
            }
            // Rear lamps also represent observed activity; decorative body color never claims execution.
            if (["rear-lights", "headlights"].includes(original.name)) {
              object.material.emissiveIntensity = 0.08;
              lights.push(object.material);
            }
          }
          if (/^wheel-(front|rear)(-(left|right))?$/.test(object.name)) wheels.push(object);
        });
        // oxlint-disable-next-line unicorn/no-useless-spread -- Removing Three.js children mutates this array; iterate a snapshot.
        for (const child of [...vehicle.group.children])
          if (child !== vehicle.ring) {
            vehicle.group.remove(child);
            child.traverse((object) => object.geometry?.dispose());
          }
        vehicle.group.add(imported);
        vehicle.lamps = lights;
        vehicle.wheels = wheels;
      }
      for (const result of results)
        if (result.status === "fulfilled")
          result.value.scene.traverse((object) => {
            if (Array.isArray(object.material))
              object.material.forEach((material) => material.dispose());
            else object.material?.dispose();
          });
      onChange();
    },
    update(model, time) {
      road.position.z = (time * 5) % 5;
      for (const state of model.vehicles) {
        const vehicle = vehicles.get(state.id);
        if (!vehicle) continue;
        vehicle.ring.visible = state.selected;
        for (const lamp of vehicle.lamps) lamp.emissiveIntensity = state.active ? 3 : 0.08;
        // No idle bobbing: activity means an observed dispatch, never a selected tile.
        vehicle.group.position.y = 0;
        vehicle.group.rotation.z = 0;
        if (state.active && model.moving) {
          vehicle.group.position.y = Math.sin(time * 12 + vehicle.origin[0]) * 0.014;
          vehicle.group.rotation.z =
            state.id === "lead" ? 0 : Math.sin(time * 1.2 + vehicle.origin[0]) * 0.025;
          for (const wheel of vehicle.wheels) wheel.rotation.x = -time * 8;
        }
      }
    },
  };
}
