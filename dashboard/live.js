// XuViGaN Persistence Dashboard - Spatial Data Visualization
// Using Three.js for 3D visualization instead of traditional D3 graph

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
let ws = null;
let scene, camera, renderer, controls;
let nodes = [], links = [];
let threeNodes = new Map(); // Map for 3D nodes
let threeLinks = []; // Array for 3D links

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Load saved theme
    const savedTheme = localStorage.getItem('persistence-theme');
    if (savedTheme === 'cyberpunk') {
        document.getElementById('theme-stylesheet').disabled = false;
    }

    initThreeJS();
    connectWebSocket();
    loadStats();
    initControls();
    initInterfaceSelector();

    // Handle window resize
    window.addEventListener('resize', () => {
        camera.aspect = document.getElementById('three-container').clientWidth / document.getElementById('three-container').clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(document.getElementById('three-container').clientWidth, document.getElementById('three-container').clientHeight);
    });
});

// Three.js initialization for 3D visualization
function initThreeJS() {
    const container = document.getElementById('three-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.FogExp2(0x0a0a12, 0.05);

    // Create camera
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 50;

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    scene.add(ambientLight);

    // Add directional light
    const directionalLight = new THREE.DirectionalLight(0x00f0ff, 1);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Add point lights for each color
    const colors = [0x00f0ff, 0x00ff88, 0x8866ff, 0xff3366, 0xffaa00];
    colors.forEach((color, i) => {
        const light = new THREE.PointLight(color, 1, 100);
        light.position.set(
            Math.cos(i * Math.PI * 2 / colors.length) * 30,
            Math.sin(i * Math.PI * 2 / colors.length) * 30,
            0
        );
        scene.add(light);
    });

    // Add particles background
    createParticleBackground();

    // Add controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 10;
    controls.maxDistance = 200;

    // Animation loop
    animate();
}

// Create particle background
function createParticleBackground() {
    const particleCount = 1000;
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;

        // Positions
        positions[i3] = (Math.random() - 0.5) * 200;
        positions[i3 + 1] = (Math.random() - 0.5) * 200;
        positions[i3 + 2] = (Math.random() - 0.5) * 200;

        // Colors
        colors[i3] = 0;     // R
        colors[i3 + 1] = 0.9; // G
        colors[i3 + 2] = 1;   // B
    }

    particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particles.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const particleMaterial = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.7
    });

    const particleSystem = new THREE.Points(particles, particleMaterial);
    scene.add(particleSystem);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    // Update controls
    controls.update();

    // Rotate data cube
    const cube = document.querySelector('.logo-cube');
    if (cube) {
        cube.style.transform = `rotateX(${Date.now() * 0.01}deg) rotateY(${Date.now() * 0.015}deg)`;
    }

    // Animate nodes if they exist
    threeNodes.forEach((node3d, id) => {
        // Find corresponding data node
        const nodeData = nodes.find(n => n.id === id);
        if (nodeData) {
            // Pulse animation
            const scale = 1 + Math.sin(Date.now() * 0.002 + parseInt(id.replace(/\D/g, ''))) * 0.1;
            node3d.scale.set(scale, scale, scale);

            // Rotate for type-specific animations
            if (nodeData.type === 'project') {
                node3d.rotation.y += 0.002;
            } else if (nodeData.type === 'session') {
                node3d.rotation.x += 0.003;
            }
        }
    });

    renderer.render(scene, camera);
}

// Create 3D nodes from data
function create3DNodes() {
    // Clear existing nodes
    threeNodes.forEach((node3d, id) => {
        scene.remove(node3d);
    });
    threeNodes.clear();

    // Clear existing links
    threeLinks.forEach(link => {
        scene.remove(link);
    });
    threeLinks = [];

    // Create nodes
    nodes.forEach(node => {
        let geometry, material, mesh;

        // Create different geometry based on node type
        switch (node.type) {
            case 'project':
                // Create a complex icosahedron for projects
                geometry = new THREE.IcosahedronGeometry(node.size / 10, 1);
                break;
            case 'session':
                // Create a torus knot for sessions
                geometry = new THREE.TorusKnotGeometry(node.size / 15, node.size / 30, 100, 16);
                break;
            case 'error':
                // Create a sharp octahedron for errors
                geometry = new THREE.OctahedronGeometry(node.size / 8, 1);
                break;
            case 'file':
                // Create a custom shape for files
                geometry = new THREE.BoxGeometry(node.size / 10, node.size / 10, node.size / 10);
                break;
            default:
                // Default sphere for actions
                geometry = new THREE.SphereGeometry(node.size / 10, 16, 16);
        }

        // Create material with glow effect
        material = new THREE.MeshPhongMaterial({
            color: node.color.replace('#', '0x'),
            emissive: node.color.replace('#', '0x'),
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.9,
            specular: 0xffffff,
            shininess: 30
        });

        // Create mesh
        mesh = new THREE.Mesh(geometry, material);

        // Position randomly in 3D space
        mesh.position.x = (Math.random() - 0.5) * 80;
        mesh.position.y = (Math.random() - 0.5) * 80;
        mesh.position.z = (Math.random() - 0.5) * 80;

        // Store reference
        mesh.userData = { id: node.id, type: node.type };

        // Add to scene and map
        scene.add(mesh);
        threeNodes.set(node.id, mesh);
    });

    // Create links between nodes
    links.forEach(link => {
        const sourceNode = threeNodes.get(link.source.id || link.source);
        const targetNode = threeNodes.get(link.target.id || link.target);

        if (sourceNode && targetNode) {
            // Create a curve for the link
            const curve = new THREE.QuadraticBezierCurve3(
                sourceNode.position,
                new THREE.Vector3(
                    (sourceNode.position.x + targetNode.position.x) / 2,
                    (sourceNode.position.y + targetNode.position.y) / 2,
                    (sourceNode.position.z + targetNode.position.z) / 2 + 10 // Curve upward
                ),
                targetNode.position
            );

            // Create tube geometry for the link
            const geometry = new THREE.TubeGeometry(curve, 20, 0.2, 8, false);
            const material = new THREE.MeshPhongMaterial({
                color: getLinkColor(link.type).replace('#', '0x'),
                transparent: true,
                opacity: 0.4,
                emissive: getLinkColor(link.type).replace('#', '0x'),
                emissiveIntensity: 0.3
            });

            const linkMesh = new THREE.Mesh(geometry, material);
            scene.add(linkMesh);
            threeLinks.push(linkMesh);
        }
    });
}

// Get color for link based on type
function getLinkColor(type) {
    const colors = {
        'contains': '#00f0ff',
        'executes': '#ffaa00',
        'modifies': '#ffcc00',
        'threw': '#ff0044'
    };
    return colors[type] || '#ffffff';
}

// WebSocket connection
function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('Connected to dashboard server');
        addEvent('system', 'Connected to live feed');
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
            case 'init':
                updateGraph(msg.data);
                loadStats();
                break;
            case 'graph_update':
                updateGraph(msg.data);
                loadStats();
                break;
            case 'event':
                handleLiveEvent(msg.event, msg.data);
                break;
        }
    };

    ws.onclose = () => {
        console.log('Disconnected, reconnecting in 3s...');
        addEvent('system', 'Connection lost, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// Update graph data
function updateGraph(data) {
    if (!data || !data.nodes) return;

    nodes = data.nodes;
    links = data.links;

    // Create 3D visualization
    create3DNodes();
}

// Load statistics
function loadStats() {
    fetch('/api/stats')
        .then(r => r.json())
        .then(data => {
            document.getElementById('stat-projects').textContent = data.projects || 0;
            document.getElementById('stat-sessions').textContent = data.sessions || 0;
            document.getElementById('stat-actions').textContent = data.actions || 0;
            document.getElementById('stat-errors').textContent = data.errors || 0;
        });
}

// Handle live events
function handleLiveEvent(eventType, data) {
    const typeMap = {
        'session_start': { label: 'Session Started', class: 'session' },
        'session_end': { label: 'Session Ended', class: 'session' },
        'action': { label: data?.tool || 'Action', class: 'action' },
        'error': { label: data?.error_type || 'Error', class: 'error' },
        'file_edit': { label: 'File Modified', class: 'action' },
        'dialog': { label: 'Dialog Entry', class: 'session' }
    };

    const info = typeMap[eventType] || { label: eventType, class: 'session' };
    addEvent(info.class, info.label, data);

    // Flash effect on graph
    flashGraph();
}

// Add event to feed
function addEvent(type, label, data) {
    const feed = document.getElementById('events-feed');
    const item = document.createElement('div');
    item.className = `event-item ${type}`;

    const time = new Date().toLocaleTimeString();
    let detail = '';
    if (data) {
        if (data.summary) detail = data.summary.slice(0, 50);
        else if (data.project_dir) detail = data.project_dir.split(/[\\/]/).pop();
        else if (data.message) detail = data.message.slice(0, 50);
    }

    item.innerHTML = `
        <div class="event-time">${time}</div>
        <div class="event-type">${label}</div>
        ${detail ? `<div style="color: #888; font-size: 11px;">${detail}</div>` : ''}
    `;

    feed.insertBefore(item, feed.firstChild);

    // Limit feed
    while (feed.children.length > 20) {
        feed.removeChild(feed.lastChild);
    }
}

// Flash effect on graph
function flashGraph() {
    const container = document.getElementById('three-container');
    container.style.boxShadow = 'inset 0 0 100px rgba(0, 240, 255, 0.1)';
    setTimeout(() => {
        container.style.boxShadow = 'none';
    }, 300);
}

// Initialize controls
function initControls() {
    // Export PNG
    document.getElementById('btn-export-png').addEventListener('click', exportPNG);

    // Export JSON
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);

    // Toggle theme
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);

    // Reset view
    document.getElementById('btn-reset').addEventListener('click', resetView);

    // Search
    document.getElementById('search-box').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        searchNodes(term);
    });
}

// Initialize interface selector
function initInterfaceSelector() {
    document.querySelectorAll('.interface-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active class from all buttons
            document.querySelectorAll('.interface-btn').forEach(b => b.classList.remove('active'));

            // Add active class to clicked button
            e.target.classList.add('active');

            // Hide all visualizations
            document.querySelectorAll('.visualization').forEach(viz => viz.classList.remove('active'));

            // Show selected visualization
            const interfaceType = e.target.dataset.interface;
            document.getElementById(`${interfaceType}-view`).classList.add('active');

            // If switching to 3D graph, re-render
            if (interfaceType === 'graph') {
                camera.aspect = document.getElementById('three-container').clientWidth / document.getElementById('three-container').clientHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(document.getElementById('three-container').clientWidth, document.getElementById('three-container').clientHeight);
            }
        });
    });
}

// Export PNG
function exportPNG() {
    if (typeof html2canvas !== 'undefined') {
        html2canvas(document.getElementById('visualization-container')).then(canvas => {
            const link = document.createElement('a');
            link.download = `persistence-graph-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    } else {
        alert('html2canvas library not loaded. Cannot export PNG.');
    }
}

// Export JSON
function exportJSON() {
    const data = {
        nodes: nodes,
        links: links,
        timestamp: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.download = `persistence-graph-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    link.href = url;
    link.click();

    URL.revokeObjectURL(url);
}

// Toggle theme
function toggleTheme() {
    const themeLink = document.getElementById('theme-stylesheet');
    themeLink.disabled = !themeLink.disabled;

    // Save preference to localStorage
    localStorage.setItem('persistence-theme', themeLink.disabled ? 'default' : 'cyberpunk');
}

// Reset view
function resetView() {
    // Reset camera position
    controls.reset();

    // Reset search
    document.getElementById('search-box').value = '';

    // Reset node highlighting
    threeNodes.forEach(node3d => {
        node3d.material.opacity = 0.9;
        node3d.material.emissiveIntensity = 0.5;
    });

    // Reset link highlighting
    threeLinks.forEach(link => {
        link.material.opacity = 0.4;
    });

    // Reset info panel
    document.getElementById('node-info').innerHTML = '<p class="placeholder">Select a node to view details</p>';
}

// Search nodes
function searchNodes(term) {
    if (!term) {
        threeNodes.forEach(node3d => {
            node3d.material.opacity = 0.9;
            node3d.material.emissiveIntensity = 0.5;
        });
        return;
    }

    // Find matching nodes
    const matchingIds = new Set();
    nodes.forEach(node => {
        if (node.label.toLowerCase().includes(term) ||
            (node.path && node.path.toLowerCase().includes(term)) ||
            (node.id && node.id.toLowerCase().includes(term))) {
            matchingIds.add(node.id);
        }
    });

    // Highlight matching nodes
    threeNodes.forEach((node3d, id) => {
        if (matchingIds.has(id)) {
            node3d.material.opacity = 1;
            node3d.material.emissiveIntensity = 1;
        } else {
            node3d.material.opacity = 0.3;
            node3d.material.emissiveIntensity = 0.2;
        }
    });
}

// Handle node click
function showNodeDetails(event) {
    // Raycast to find clicked node
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Calculate mouse position in normalized device coordinates
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update the picking ray with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Calculate objects intersecting the picking ray
    const intersects = raycaster.intersectObjects(scene.children);

    for (let i = 0; i < intersects.length; i++) {
        if (intersects[i].object.userData.id) {
            const nodeId = intersects[i].object.userData.id;
            const nodeData = nodes.find(n => n.id === nodeId);

            if (nodeData) {
                const info = document.getElementById('node-info');
                let html = `<span class="type-badge ${nodeData.type}">${nodeData.type}</span>`;
                html += `<h4 style="margin: 8px 0; color: ${nodeData.color}">${nodeData.label}</h4>`;

                const fields = {
                    project: ['path', 'sessions', 'actions'],
                    session: ['id', 'status', 'agent', 'model', 'actions', 'errors', 'duration', 'started'],
                    action: ['tool', 'summary', 'status', 'attempt', 'time'],
                    error: ['message', 'stack', 'time'],
                    file: ['path', 'edits']
                };

                const labels = {
                    path: 'Path', sessions: 'Sessions', actions: 'Actions',
                    id: 'Session ID', status: 'Status', agent: 'Agent',
                    model: 'Model', errors: 'Errors', duration: 'Duration (s)',
                    started: 'Started', tool: 'Tool', summary: 'Summary',
                    attempt: 'Attempts', time: 'Time', message: 'Message',
                    stack: 'Stack', edits: 'Edit Count'
                };

                fields[nodeData.type]?.forEach(f => {
                    const val = nodeData[f];
                    if (val !== undefined && val !== null) {
                        html += `<div class="field"><div class="key">${labels[f] || f}</div><div class="val">${String(val).slice(0, 300)}</div></div>`;
                    }
                });

                info.innerHTML = html;

                // Highlight connected nodes
                highlightConnectedNodes(nodeId);
                break;
            }
        }
    }
}

// Highlight connected nodes
function highlightConnectedNodes(nodeId) {
    // Find connected node IDs
    const connectedIds = new Set();
    links.forEach(link => {
        if (link.source.id === nodeId) connectedIds.add(link.target.id);
        if (link.target.id === nodeId) connectedIds.add(link.source.id);
    });

    // Highlight nodes
    threeNodes.forEach((node3d, id) => {
        if (id === nodeId) {
            node3d.material.opacity = 1;
            node3d.material.emissiveIntensity = 1.5;
        } else if (connectedIds.has(id)) {
            node3d.material.opacity = 0.9;
            node3d.material.emissiveIntensity = 1;
        } else {
            node3d.material.opacity = 0.2;
            node3d.material.emissiveIntensity = 0.1;
        }
    });

    // Highlight links
    threeLinks.forEach(link => {
        // This is a simplification - in a real implementation, we'd need to track which links connect to which nodes
        link.material.opacity = 0.7;
    });
}

// Add event listener for node clicks
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('three-container').addEventListener('click', showNodeDetails);
});
