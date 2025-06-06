import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader'
import rhino3dm from 'rhino3dm'

const loader = new Rhino3dmLoader()
loader.setLibraryPath('https://unpkg.com/rhino3dm@8.0.0-beta3/')

const data = {
  // definition: 'form_io_main_002.gh',
  definition: 'test_main_2.gh',

  inputs: {}  // initialize as empty
}

// Rhino library instance
let doc
const rhino = await rhino3dm()
console.log('Loaded rhino3dm.')

let threeScene, threeCamera, threeRenderer
let map
let meshb64Mesh, meshoutMesh

init()

function getInputs() {
  const inputs = {};
  document.querySelectorAll('#overlay input').forEach(input => {
    const id = input.id;
    if (input.type === 'checkbox') {
      inputs[id] = input.checked ? 1 : 0;
    } else {
      inputs[id] = Number(input.value);
    }
  });

  // Include flattened building path
  if (PROJECT_POLYLINE) {
    // Use Turf-accurate coordinates
    const origin = '0,0,0';
    const vertices = formatBuildingPathWithTurfDistances(PROJECT_POLYLINE);

    inputs['building_origin'] = origin;
    inputs['building_vertices'] = vertices;

  }

  formatBuildingPathWithTurfDistances(PROJECT_POLYLINE);

  return inputs;
}


async function compute() {
  if (!threeScene) return


  data.inputs = getInputs()

  const formData = new FormData()
  formData.append("grasshopper_file_name", data.definition)
  formData.append("input_data", JSON.stringify(data.inputs))

  try {
    const response = await fetch("/api/rhino/solve/", {
      method: "POST",
      body: formData,
      headers: {
        "X-CSRFToken": getCSRFToken(),
      },
    })
    if (!response.ok) throw new Error(response.statusText)
    const json = await response.json()
    collectResults(json)
  } catch (e) {
    console.error('Compute failed:', e)
  }
}

// Helper to get accurate meter-to-Mercator scaling factor
function getMercatorUnitsPerMeterAtOrigin(originLngLat) {
  // Create a point 1 meter east of the origin
  const originPoint = turf.point([originLngLat.lng, originLngLat.lat]);
  const offsetPoint = turf.destination(originPoint, 1, 90, { units: 'meters' }); // 90° = east

  const mercOrigin = mapboxgl.MercatorCoordinate.fromLngLat(originLngLat);
  const mercOffset = mapboxgl.MercatorCoordinate.fromLngLat({
    lng: offsetPoint.geometry.coordinates[0],
    lat: offsetPoint.geometry.coordinates[1]
  });

  const dx = mercOffset.x - mercOrigin.x;

  return dx; // true Mercator units per 1 meter at this location
}



function meshToThreejs(mesh) {
  const loader = new THREE.BufferGeometryLoader();
  const geometry = loader.parse(mesh.toThreejsJSON());

  // Get accurate scale factor from turf-based east offset
  const mercOrigin = new mapboxgl.MercatorCoordinate(
    PROJECT_POLYLINE.origin.x,
    PROJECT_POLYLINE.origin.y
  );
  const originLngLat = mercOrigin.toLngLat();

  const mercatorPerMeter = getMercatorUnitsPerMeterAtOrigin(originLngLat);

  geometry.scale(mercatorPerMeter, mercatorPerMeter, mercatorPerMeter);

  
  console.log('Mercator scale factor:', mercatorPerMeter);
  geometry.computeBoundingBox();
  console.log('Original geometry size:', geometry.boundingBox);


  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.8
  });

  return new THREE.Mesh(geometry, material);
}


function replaceCurrentMesh(mesh, type) {
  if (type === 'meshb64' && meshb64Mesh) {
    threeScene.remove(meshb64Mesh)
    meshb64Mesh.geometry.dispose()
    meshb64Mesh.material.dispose()
    meshb64Mesh = null
  } else if (type === 'meshout' && meshoutMesh) {
    threeScene.remove(meshoutMesh)
    meshoutMesh.geometry.dispose()
    meshoutMesh.material.dispose()
    meshoutMesh = null
  }
  if (type === 'meshb64') {
    meshb64Mesh = mesh
    mesh.geometry.rotateX(Math.PI)
    mesh.geometry.scale(1, 1, -1) // Flip Y-axis for correct orientation
    // mesh.geometry.rotateY(Math.PI*2)

    threeScene.add(meshb64Mesh)
  } else if (type === 'meshout') {
    meshoutMesh = mesh
    mesh.geometry.rotateX(Math.PI)
    mesh.geometry.scale(1, 1, -1) // Flip Y-axis for correct orientation
    // mesh.geometry.rotateY(Math.PI*2)

    threeScene.add(meshoutMesh)
  }
}

function decodeItem(item) {
  const data = JSON.parse(item.data)
  if (item.type === 'System.String') {
    try {
      return rhino.DracoCompression.decompressBase64String(data)
    } catch {}
  } else if (typeof data === 'object') {
    return rhino.CommonObject.decode(data)
  }
  return null
}

function collectResults(json) {
  if (doc) doc.delete();
  doc = new rhino.File3dm();

  json.values.forEach(output => {
    const branches = output.InnerTree;

    Object.values(branches).forEach(branch => {
      branch.forEach(item => {
        const obj = decodeItem(item);
        if (obj) {
          const mesh = meshToThreejs(obj);

          // --- Accurate translation using origin from Mercator-based polyline
          const originX = PROJECT_POLYLINE?.origin?.x || 0;
          const originY = PROJECT_POLYLINE?.origin?.y || 0;
          mesh.position.set(originX, originY, 0);

          // --- Apply rotation based on building path orientation (first edge direction)
          const points = PROJECT_POLYLINE?.points;
          if (points?.length >= 2) {
            const dx = points[1].x - points[0].x;
            const dy = points[1].y - points[0].y;
            const angle = Math.atan2(dy, dx); // Z-axis rotation in radians
            mesh.geometry.rotateZ = angle;
          }

          // --- Place the mesh into the scene
          const isMeshb64 = output.ParamName.includes('meshb64');
          replaceCurrentMesh(mesh, isMeshb64 ? 'meshb64' : 'meshout');


          // --- Store decoded object (optional)
          doc.objects().add(obj, null);
        }
      });
    });
  });
}



// Global variables for site and building polygons
let sitePolygonId = null;
let buildingPolygonId = null;
let siteLabelMarkers = [];
let buildingLabelMarkers = [];

function init() {
  const siteBounds = getBoundsFromSiteGeometry(PROJECT_SITE);
  const paddedBounds = getPaddedBounds(siteBounds.bounds);

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: siteBounds.center,
    zoom: 16,
    pitch: 60,
    bearing: -17.6,
    antialias: true,
    maxBounds: paddedBounds
  });

  // Initialize MapboxDraw
  const draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {
      polygon: true,
      trash: true
    },
    defaultMode: 'draw_polygon'
  });
  map.addControl(draw, 'top-right');

  // Draw Rectangle Button
  const drawRectangleBtn = document.createElement('button');
  drawRectangleBtn.innerText = "Draw Rectangle";
  drawRectangleBtn.className = 'btn btn-primary m-2';
  drawRectangleBtn.onclick = () => draw.changeMode('draw_polygon');
  document.getElementById('overlay').prepend(drawRectangleBtn);

  map.on('load', () => {
    // Site layer and polygon
    if (PROJECT_SITE?.features?.length) {
      const siteFeature = PROJECT_SITE.features[0];
      siteFeature.properties = { role: 'site' };

      map.addSource('site', {
        type: 'geojson',
        data: PROJECT_SITE
      });

      map.addLayer({
        id: 'site-boundary',
        type: 'fill',
        source: 'site',
        paint: {
          'fill-color': '#3b82f6',
          'fill-opacity': 0.1
        }
      });

      const addedSite = draw.add(siteFeature);
      sitePolygonId = addedSite[0];
      clearSiteLabels();
      showSiteBoundaryDimensions(siteFeature);
    }

    // Building layer and polygon
    const buildingFeature = buildingPathToGeoJSON(PROJECT_POLYLINE);
    if (buildingFeature) {
      buildingFeature.properties = { role: 'building' };

      map.addSource('building', {
        type: 'geojson',
        data: buildingFeature
      });

      map.addLayer({
        id: 'building-boundary',
        type: 'fill',
        source: 'building',
        paint: {
          'fill-color': '#f97316',
          'fill-opacity': 0.5
        }
      });

      const addedBuilding = draw.add(buildingFeature);
      buildingPolygonId = addedBuilding[0];
      clearBuildingLabels();
      showBuildingPathDimensions(buildingFeature.geometry);
    }

    // 3D buildings
    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.3
      }
    });

    // Hide street labels
    map.getStyle().layers.forEach(layer => {
      if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    });

    map.fitBounds(siteBounds.bounds, { padding: 30, duration: 0 });
    map.addLayer(customLayer);
  });

  // Create handler
  map.on('draw.create', function (e) {
    const feature = e.features[0];
    if (!feature || feature.geometry.type !== 'Polygon') return;

    const role = feature.properties?.role || null;

    if (role === 'site') {
      sitePolygonId = feature.id;
      saveSiteGeometry(feature.geometry);
      clearSiteLabels();
      showSiteBoundaryDimensions(feature);
    } else {
      buildingPolygonId = feature.id;
      handleBuildingPath(feature.geometry);
      updateBuildingSource(feature.geometry);
      clearBuildingLabels();
      showBuildingPathDimensions(feature.geometry);
    }
  });

  // Update handler
  map.on('draw.update', function (e) {
    const feature = e.features[0];
    const role = feature.properties?.role;

    if (role === 'site') {
      saveSiteGeometry(feature.geometry);
      clearSiteLabels();
      showSiteBoundaryDimensions(feature);
    } else if (role === 'building') {
      handleBuildingPath(feature.geometry);
      updateBuildingSource(feature.geometry);
      clearBuildingLabels();
      showBuildingPathDimensions(feature.geometry);
    }
  });

  // Delete handler
  map.on('draw.delete', function (e) {
    e.features.forEach(f => {
      if (f.id === sitePolygonId) {
        sitePolygonId = null;
        clearSiteLabels();
        console.warn('[Form IO] Site boundary deleted');
      } else if (f.id === buildingPolygonId) {
        buildingPolygonId = null;
        clearBuildingLabels();
        console.warn('[Form IO] Building path deleted');
      }
    });
  });

  // Helper: update building geojson source
  function updateBuildingSource(geometry) {
    const updatedFeature = {
      type: "Feature",
      geometry: geometry,
      properties: { role: "building" }
    };
    const updatedGeojson = {
      type: "FeatureCollection",
      features: [updatedFeature]
    };
    const buildingSource = map.getSource('building');
    if (buildingSource) {
      buildingSource.setData(updatedGeojson);
    }
  }
}



const customLayer = {
  id: 'rhino-layer',
  type: 'custom',
  renderingMode: '3d',
  onAdd: async function (_map, gl) {
    threeCamera = new THREE.Camera()
    threeScene = new THREE.Scene()
    threeRenderer = new THREE.WebGLRenderer({
      canvas: _map.getCanvas(),
      context: gl,
      antialias: true
    })
    threeRenderer.autoClear = false

    // ✅ Wait for input UI to be ready before computing
    await fetchGrasshopperInputs(data.definition);
    registerInputListeners(); // Attach events to newly created input elements
    preloadInputs(PROJECT_INPUTS); // Optional: load saved input values if available
    compute(); // Now inputs are ready and UI is populated
  },

  render: function (gl, matrix) {
    const m = new THREE.Matrix4().fromArray(matrix)
    threeCamera.projectionMatrix = m
    threeRenderer.state.reset()
    threeRenderer.render(threeScene, threeCamera)
    map.triggerRepaint()
  }
}


function buildingPathToGeoJSON(path) {
  if (!path || !path.origin || !Array.isArray(path.points)) return null;

  const coords = path.points.map(p => [p.x + path.origin.x, p.y + path.origin.y]);

  // Ensure closed polygon
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);

  // Convert Mercator to LngLat
  const lngLatCoords = coords.map(pair => {
    const merc = new mapboxgl.MercatorCoordinate(pair[0], pair[1]);
    const { lng, lat } = merc.toLngLat();
    return [lng, lat];
  });


  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [lngLatCoords]
    }
  };
}


function saveSiteGeometry(geometry) {
  if (!PROJECT_ID) return;

  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: geometry,
        properties: {}
      }
    ]
  };

  const payload = {
    inputs: getInputs(),  // keep if needed
    site_geometry: geojson
  };

  fetch(`/api/projects/${PROJECT_ID}/save/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCSRFToken()
    },
    body: JSON.stringify(payload)
  }).then(res => {
    if (!res.ok) throw new Error('Site geometry save failed');
    console.log('[Form IO] Site boundary updated successfully');
  }).catch(err => {
    console.error('[Form IO] Failed to save site boundary:', err);
  });
}

function handleBuildingPath(geometry) {
  const coords = geometry.coordinates[0];
  const originLngLat = coords[0];

  const origin = mapboxgl.MercatorCoordinate.fromLngLat({
    lng: originLngLat[0],
    lat: originLngLat[1]
  });

  const points = coords.map(([lng, lat]) => {
    const point = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat });
    return {
      x: point.x - origin.x,
      y: point.y - origin.y,
      z: 0
    };
  });

  const relativePath = {
    origin: { x: origin.x, y: origin.y, z: 0 },
    points: points
  };

  saveBuildingPath(relativePath); // Persist to backend

  // ✅ Trigger updateInputs after saving
  const formatted = formatBuildingPathAsStrings(relativePath);
  updateInputs({
    building_origin: formatted.origin,
    building_vertices: formatted.vertices
  });
}


function saveBuildingPath(buildingPath) {
  if (!PROJECT_ID) return;

  const payload = {
    inputs: getInputs(),
    building_path: buildingPath
  };

  fetch(`/api/projects/${PROJECT_ID}/save/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCSRFToken()
    },
    body: JSON.stringify(payload)
  }).then(res => {
    if (!res.ok) throw new Error('Save failed');
    console.log('[Form IO]Updated succesfully');
  }).catch(err => {
    console.error('[Form IO] Failed to save rectangle:', err);
  });
}

function getPaddedBounds(bounds, paddingDegrees = 0.001) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const paddedSw = new mapboxgl.LngLat(sw.lng - paddingDegrees, sw.lat - paddingDegrees);
  const paddedNe = new mapboxgl.LngLat(ne.lng + paddingDegrees, ne.lat + paddingDegrees);

  return new mapboxgl.LngLatBounds(paddedSw, paddedNe);
}

function getBoundsFromSiteGeometry(geojson) {
  const bbox = turf.bbox(geojson); // [minX, minY, maxX, maxY]

  // Get original bounds and center
  const sw = new mapboxgl.LngLat(bbox[0], bbox[1]);
  const ne = new mapboxgl.LngLat(bbox[2], bbox[3]);
  const bounds = new mapboxgl.LngLatBounds(sw, ne);
  const center = bounds.getCenter();

  // Compute half-widths
  const lngSpan = (ne.lng - sw.lng) / 2;
  const latSpan = (ne.lat - sw.lat) / 2;

  // Expand outward from center (2x scale)
  const scaledSW = new mapboxgl.LngLat(center.lng - lngSpan, center.lat - latSpan);
  const scaledNE = new mapboxgl.LngLat(center.lng + lngSpan, center.lat + latSpan);

  const scaledBounds = new mapboxgl.LngLatBounds(scaledSW, scaledNE);
  return {
    bounds: scaledBounds,
    center: [center.lng, center.lat]
  };
}



function getCSRFToken() {
  const name = 'csrftoken'
  const cookieValue = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)')
  return cookieValue ? cookieValue.pop() : ''
}


// Loader messages and logic
let loaderInterval;
const loaderMessages = ["Talking to OpenAI...", "Analyzing prompt", "Loading model"];
let currentLoaderIndex = 0;

function showLoader() {
    const loader = document.getElementById('loader');
    loader.style.display = 'block';
    loader.textContent = loaderMessages[currentLoaderIndex]; // Set initial message
    loaderInterval = setInterval(() => {
        currentLoaderIndex = (currentLoaderIndex + 1) % loaderMessages.length;
        loader.textContent = loaderMessages[currentLoaderIndex]; // Cycle through messages
    }, 1000); // Change message every 1 second
}

function hideLoader() {
    const loader = document.getElementById('loader');
    loader.style.display = 'none';
    clearInterval(loaderInterval);
    currentLoaderIndex = 0; // Reset index
}

function updateInputs(parameters) {
    // Loop through parameters and update corresponding input fields
    Object.keys(parameters).forEach(key => {
        const inputElement = document.getElementById(key); // Ensure IDs match backend keys
        if (inputElement) {
            inputElement.value = parameters[key]; // Update input value directly
        }
    });
    // Trigger compute after updating inputs
    onSliderChange();
    }

    document.getElementById('send_prompt').addEventListener('click', async () => {
        const chatbox = document.getElementById('chatbox');
        const prompt = chatbox.value.trim();
        if (!prompt) return; // Prevent empty submissions
        // Add user prompt as chat-start bubble
        addChatMessage(prompt, false);
        // Clear the textarea
        chatbox.value = '';
        // Show the loader
        showLoader();
        try {
            const csrfToken = getCSRFToken(); // Ensure you have the CSRF token logic
            const response = await fetch('/api/openai/chat/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                },
                body: JSON.stringify({ prompt })
            });
            if (response.ok) {
                const data = await response.json();
                // Debugging: Check the received data in the console
                console.log("Response JSON:", data);
                console.log("Response Reasoning:", data.parameters.reasoning);
                console.log("Response Parameters:", data.parameters.parameters);
                // Check and add reasoning from the response as chat-end bubble
                if (data.parameters.reasoning) {
                    addChatMessage(data.parameters.reasoning, true);
                } else {
                    addChatMessage('Error: No reasoning found in the response.', true);
                }
                // Call updateInputs to update form fields with parameters from the response
                if (data.parameters) {
                    updateInputs(data.parameters.parameters);
                }
            } else {
                addChatMessage('Error: Unable to process the prompt.', true);
            }
        } catch (error) {
            console.error('Error during fetch:', error);
            addChatMessage('Error: Unable to reach the server.', true);
        } finally {
            // Hide the loader
            hideLoader();
        }
    });

// Function to append a chat message dynamically
function addChatMessage(message, isResponse = false) {
    const chatMessages = document.getElementById('chat-messages');
    // Create chat container
    const chat = document.createElement('div');
    chat.className = `chat ${isResponse ? 'chat-start' : 'chat-end'}`;
    // Create chat bubble
    const chatBubble = document.createElement('div');
    chatBubble.className = 'chat-bubble';
    chatBubble.innerHTML = message;
    // Append bubble to chat and chat to chat messages container
    chat.appendChild(chatBubble);
    chatMessages.appendChild(chat);
    // Scroll to the bottom of the chat box
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// Preload input values on page load
function preloadInputs(savedInputs) {
  if (!savedInputs || typeof savedInputs !== 'object') return;

  Object.entries(savedInputs).forEach(([key, value]) => {
    const element = document.getElementById(key);
    if (!element) return;

    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  });

  console.log('[Form IO] Preloaded saved inputs for project:', PROJECT_ID);
}

// Save inputs to the backend (called after changes)
async function saveInputsToProject(inputs) {
  if (!PROJECT_ID) return;

  try {
    await fetch(`/api/projects/${PROJECT_ID}/save/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCSRFToken(),
      },
      body: JSON.stringify(inputs),
    });
    console.log('[Form IO] Inputs saved successfully for project:', PROJECT_ID);
  } catch (error) {
    console.warn('[Form IO] Failed to save inputs:', error);
  }
}

function onSliderChange() {
  console.log('[Form IO] Slider/input changed – recomputing...');
  compute();
}

// Dynamically attach events to all inputs in overlay
function registerInputListeners() {
  document.querySelectorAll('#overlay input, #overlay textarea').forEach(input => {
    // Trigger recompute when user changes value manually
    input.addEventListener('input', onSliderChange, false);
    input.addEventListener('change', onSliderChange, false);

    // Optional: still keep mouse/touch if needed
    input.addEventListener('mouseup', onSliderChange, false);
    input.addEventListener('touchend', onSliderChange, false);
  });
}



async function fetchGrasshopperInputs(definitionFile) {
  try {
    console.log("definition",definitionFile)
    const response = await fetch(`/api/rhino/params/?file=${encodeURIComponent(definitionFile)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch inputs: ${response.statusText}`);
    }
    const data = await response.json();
    console.log("inputs",data)
    // Extract the parameter names from response (assuming same schema as Rhino Compute)
    const inputs = extractInputsFromGrasshopperData(data);
    populateInputsUI(inputs);

  } catch (error) {
    console.error("Error fetching GH params:", error);
  }
}

function extractInputsFromGrasshopperData(data) {
  const inputs = [];

  if (data && Array.isArray(data.InputNames) && Array.isArray(data.Inputs)) {
    for (let i = 0; i < data.InputNames.length; i++) {
      const inputName = data.InputNames[i];
      const inputMeta = data.Inputs[i];

      let defaultValue = 0;
      if (
        inputMeta &&
        inputMeta.Default &&
        inputMeta.Default.InnerTree &&
        inputMeta.Default.InnerTree["{0}"] &&
        inputMeta.Default.InnerTree["{0}"][0]
      ) {
        defaultValue = inputMeta.Default.InnerTree["{0}"][0].data;
      }

      // Force known system-generated fields as text
      let type = "number";
      if (["building_origin", "building_vertices"].includes(inputName)) {
        type = "text";
      } else {
        const paramType = inputMeta?.ParamType?.toLowerCase();
        if (paramType === "boolean") {
          type = "checkbox";
        } else if (paramType === "string") {
          type = "text";
        }
      }

      inputs.push({
        name: inputName,
        default: defaultValue,
        type: type
      });
    }
  }

  return inputs;
}


/**
 * Dynamically generates the input UI form in the overlay panel.
 * Supports number, checkbox, and text types (e.g. string parameters like building_vertices).
 *
 * @param {Array} inputs - Array of input objects with { name, default, type }
 */
function populateInputsUI(inputs) {
  console.log(inputs);
  const overlay = document.getElementById('overlay');

  // Clear any existing content in the overlay panel
  overlay.innerHTML = '';

  const form = document.createElement('div');
  form.classList.add('p-4', 'bg-base-200');

  const grid = document.createElement('div');
  grid.classList.add('grid', 'grid-cols-1', 'gap-4');

  inputs.forEach(input => {
    const control = document.createElement('div');
    control.classList.add('form-control');

    const label = document.createElement('label');
    label.classList.add('label');
    label.textContent = input.name;

    let inputField;

    // For multiline strings like building_vertices, use a <textarea>
    if (input.type === 'text' && typeof input.default === 'string' && input.default.includes(';')) {
      inputField = document.createElement('textarea');
      inputField.rows = 3;
      inputField.readOnly = true;  // Optional: protect system-generated inputs
    } else {
      inputField = document.createElement('input');
      inputField.type = input.type;
      if (input.type === 'text') {
        inputField.readOnly = true; // Optional: prevent editing string inputs
      }
    }

    inputField.id = input.name;
    inputField.name = input.name;
    inputField.value = input.default;
    inputField.classList.add('input', 'input-bordered');

    control.appendChild(label);
    control.appendChild(inputField);
    grid.appendChild(control);
  });

  form.appendChild(grid);
  overlay.appendChild(form);

  // Attach slider/input listeners again
  registerInputListeners();
}


document.addEventListener('DOMContentLoaded', async () => {
  preloadInputs(PROJECT_INPUTS);  // okay if these exist
  registerInputListeners();       // not harmful, but won't bind to anything yet

  // ✅ Load GH UI and compute when ready
  await fetchGrasshopperInputs(data.definition); 
});

// Ensure the compute function is bound to the button click
document.getElementById('toggle-overlay').addEventListener('click', () => {
  document.getElementById('overlay').classList.toggle('hidden');
});

let labelMarkers = [];

function styleLabel(el) {
  el.style.padding = '2px 6px';
  el.style.background = 'white';
  el.style.borderRadius = '4px';
  el.style.fontSize = '12px';
  el.style.border = '1px solid #ccc';
  el.style.boxShadow = '0 0 2px rgba(0, 0, 0, 0.2)';
  el.style.pointerEvents = 'none';
}

function clearSiteLabels() {
  siteLabelMarkers.forEach(m => m.remove());
  siteLabelMarkers = [];
}

function flatDistance(p1, p2) {
  const c1 = mapboxgl.MercatorCoordinate.fromLngLat({ lng: p1[0], lat: p1[1] });
  const c2 = mapboxgl.MercatorCoordinate.fromLngLat({ lng: p2[0], lat: p2[1] });

  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;

  return Math.sqrt(dx * dx + dy * dy); // in meters
}


function showSiteBoundaryDimensions(feature) {
  if (!feature || feature.geometry?.type !== 'Polygon') return;

  // Clear previous edge length labels for the site boundary
  clearSiteLabels();

  const coords = feature.geometry.coordinates[0];

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    // const dist = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
    const dist = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });

    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

    const el = document.createElement('div');
    el.innerText = `${dist.toFixed(1)} m`;
    styleLabel(el);

    const marker = new mapboxgl.Marker(el)
      .setLngLat(mid)
      .addTo(map);

    siteLabelMarkers.push(marker);
  }

  // Compute and display site area in the fixed UI element
  const area = turf.area(feature);
  const areaText = area > 10000
    ? `${(area / 10000).toFixed(2)} ha`
    : `${area.toFixed(1)} m²`;

  const labelEl = document.getElementById('site-area-label');
  if (labelEl) {
    labelEl.innerText = `Site Area: ${areaText}`;
  }
}


function clearBuildingLabels() {
  buildingLabelMarkers.forEach(m => m.remove());
  buildingLabelMarkers = [];
}

function showBuildingPathDimensions(geometry) {
  if (!geometry || geometry.type !== 'Polygon') return;

  clearBuildingLabels();

  const coords = geometry.coordinates[0];
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    const dist = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

    const el = document.createElement('div');
    el.innerText = `${dist.toFixed(1)} m`;
    styleLabel(el);

    const marker = new mapboxgl.Marker(el)
      .setLngLat(mid)
      .addTo(map);

    buildingLabelMarkers.push(marker);
  }

  // Set building area in UI
  const area = turf.area(geometry);
  const areaText = area > 10000
    ? `${(area / 10000).toFixed(2)} ha`
    : `${area.toFixed(1)} m²`;

  const buildingLabelEl = document.getElementById('building-area-label');
  if (buildingLabelEl) {
    buildingLabelEl.innerText = `Building Area: ${areaText}`;
  }
}

function formatBuildingPathAsStrings(path) {
  // Format origin as a comma-separated string
  const origin = `${path.origin.x},${path.origin.y},${path.origin.z || 0}`;

  // Format points as semicolon-separated "x,y,z" strings
  const vertices = path.points
    .map(pt => `${pt.x},${pt.y},${pt.z || 0}`)
    .join(';');

  return {
    origin,
    vertices
  };
}


/**
 * Converts building path points to relative distances using Turf.js, with the first point as origin.
 * Returns a semicolon-separated string of "x,y,z" in meters.
 * 
 * @param {Object} path - The building path object with 'origin' and 'points' in Mercator meters.
 * @returns {string} - A string with each point as "x,y,z" in meters, separated by semicolons.
 */
function formatBuildingPathWithTurfDistances(path) {
  if (!path || !Array.isArray(path.points) || path.points.length === 0) {
    console.warn("Invalid building path.");
    return '';
  }

  // Compute absolute origin coordinate
  const absOriginX = path.points[0].x + path.origin.x;
  const absOriginY = path.points[0].y + path.origin.y;

  const originLngLat = new mapboxgl.MercatorCoordinate(absOriginX, absOriginY).toLngLat();
  const originPoint = [originLngLat.lng, originLngLat.lat];

  const result = path.points.map(pt => {
    const absX = pt.x + path.origin.x;
    const absY = pt.y + path.origin.y;

    const lngLat = new mapboxgl.MercatorCoordinate(absX, absY).toLngLat();
    const currentPoint = [lngLat.lng, lngLat.lat];

    const eastRef = [currentPoint[0], originPoint[1]];
    const xDist = turf.distance(originPoint, eastRef, { units: 'meters' });
    const x = currentPoint[0] >= originPoint[0] ? xDist : -xDist;

    const northRef = [originPoint[0], currentPoint[1]];
    const yDist = turf.distance(originPoint, northRef, { units: 'meters' });
    const y = currentPoint[1] >= originPoint[1] ? yDist : -yDist;

    const z = (pt.z || 0) - (path.points[0].z || 0);

    return `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  }).join(';');

  console.log('[Form IO] Turf-based relative building path string:', result);
  return result;
}
