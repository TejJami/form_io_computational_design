import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader'
import rhino3dm from 'rhino3dm'

const loader = new Rhino3dmLoader()
loader.setLibraryPath('https://unpkg.com/rhino3dm@8.0.0-beta3/')

const data = {
  definition: 'form_io_main_002.gh',
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

function meshToThreejs(mesh) {
  const loader = new THREE.BufferGeometryLoader()
  const geometry = loader.parse(mesh.toThreejsJSON())

  // Scale down from mm to meters
  geometry.scale(0.00000005, 0.00000005,0.00000005)
  

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.5
  })

  return new THREE.Mesh(geometry, material)
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
    // mesh.geometry.rotateX(Math.PI)
    mesh.geometry.rotateZ(Math.PI)

    threeScene.add(meshb64Mesh)
  } else if (type === 'meshout') {
    meshoutMesh = mesh
    // mesh.geometry.rotateX(Math.PI)
    mesh.geometry.rotateZ(Math.PI)

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
  if (doc) doc.delete()
  doc = new rhino.File3dm()
  json.values.forEach(output => {
    const branches = output.InnerTree
    Object.values(branches).forEach(branch => {
      branch.forEach(item => {
        const obj = decodeItem(item)
        if (obj) {
          const mesh = meshToThreejs(obj)
          // Compute site center in Mercator (approx meters)
          const centerLngLat = getBoundsFromSiteGeometry(PROJECT_SITE).center
          const centerCoord = mapboxgl.MercatorCoordinate.fromLngLat({ lng: centerLngLat[0], lat: centerLngLat[1] })

          const translation = new THREE.Vector3(centerCoord.x, centerCoord.y, 0)
          mesh.position.copy(translation)
          replaceCurrentMesh(mesh, output.ParamName.includes('meshb64') ? 'meshb64' : 'meshout')
          doc.objects().add(obj, null)
        }
      })
    })
  })
}

function init() {
  const siteBounds = getBoundsFromSiteGeometry(PROJECT_SITE)
  const paddedBounds = getPaddedBounds(siteBounds.bounds); 

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: siteBounds.center,
    zoom: 16,
    pitch: 60,
    bearing: -17.6,
    antialias: true,
    maxbouns: paddedBounds
  })

  map.on('load', () => {
    map.addSource('site', { type: 'geojson', data: PROJECT_SITE })
    map.addLayer({
      id: 'site-boundary',
      type: 'fill',
      source: 'site',
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': 0.1
      }
    })


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
        'fill-extrusion-opacity': 0.5
      }
    })

    // Hide all street labels and text layers
    map.getStyle().layers.forEach((layer) => {
      if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    });


    map.fitBounds(siteBounds.bounds, { padding: 30, duration: 0 })
    map.addLayer(customLayer)
  })
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

function getPaddedBounds(bounds, paddingDegrees = 0.001) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const paddedSw = new mapboxgl.LngLat(sw.lng - paddingDegrees, sw.lat - paddingDegrees);
  const paddedNe = new mapboxgl.LngLat(ne.lng + paddingDegrees, ne.lat + paddingDegrees);

  return new mapboxgl.LngLatBounds(paddedSw, paddedNe);
}

function getBoundsFromSiteGeometry(geojson) {
  const bounds = new mapboxgl.LngLatBounds()
  const coords = geojson.features?.[0]?.geometry?.coordinates?.[0] || []
  coords.forEach(([lng, lat]) => bounds.extend([lng, lat]))
  const center = bounds.getCenter()
  return { bounds, center: [center.lng, center.lat] }
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

// Ensure global project constants are set in the HTML (index.html must inject these!)
// const PROJECT_ID = typeof PROJECT_ID !== 'undefined' ? PROJECT_ID : null;
// const PROJECT_INPUTS = typeof PROJECT_INPUTS !== 'undefined' ? PROJECT_INPUTS : {};

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
  document.querySelectorAll('#overlay input').forEach(input => {
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

      // Determine input type fallback logic
      let type = "number";
      const paramType = inputMeta?.ParamType?.toLowerCase();
      if (paramType === "integer") {
        type = "number";
      } else if (paramType === "boolean") {
        type = "checkbox";
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



function populateInputsUI(inputs) {
  console.log(inputs)
  const overlay = document.getElementById('overlay');

  // Clear current input form
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

    const inputField = document.createElement('input');
    inputField.type = input.type;
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

  // Re-register listeners
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
