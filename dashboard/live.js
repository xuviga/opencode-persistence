// XuViGaN Persistence Dashboard - Live Graph

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
let ws = null;
let simulation = null;
let svg, width, height;
let nodes = [], links = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Load saved theme
    const savedTheme = localStorage.getItem('persistence-theme');
    if (savedTheme === 'cyberpunk') {
        document.getElementById('theme-stylesheet').disabled = false;
    }

    initGraph();
    connectWebSocket();
    loadStats();
    initSparkline();
    initFilters();
    initMinimap();
    initControls();

    // Handle window resize
    window.addEventListener('resize', () => {
        width = document.getElementById('graph-container').clientWidth;
        height = document.getElementById('graph-container').clientHeight;
        simulation.force('center', d3.forceCenter(width / 2, height / 2));
        simulation.alpha(0.3).restart();
        updateMinimap();
    });
});

function initGraph() {
    svg = d3.select('#graph');
    width = document.getElementById('graph-container').clientWidth;
    height = document.getElementById('graph-container').clientHeight;

    // Add defs for glow effects
    const defs = svg.append('defs');

    const filter = defs.append('filter')
        .attr('id', 'glow')
        .attr('x', '-50%')
        .attr('y', '-50%')
        .attr('width', '200%')
        .attr('height', '200%');

    filter.append('feGaussianBlur')
        .attr('stdDeviation', '3')
        .attr('result', 'coloredBlur');

    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            container.attr('transform', event.transform);
        });

    svg.call(zoom);

    const container = svg.append('g').attr('class', 'container');

    // Arrow marker for links
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', 'rgba(0,240,255,0.3)');

    // Initialize force simulation
    simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(d => {
            if (d.type === 'contains') return 80;
            if (d.type === 'executes') return 40;
            if (d.type === 'modifies') return 60;
            return 50;
        }))
        .force('charge', d3.forceManyBody().strength(d => {
            if (d.type === 'project') return -400;
            if (d.type === 'session') return -200;
            return -50;
        }))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.size + 5))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05));
}

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

function updateGraph(data) {
    if (!data || !data.nodes) return;

    nodes = data.nodes;
    links = data.links;

    // Update project filter if projects data available
    if (data.projects) {
        updateProjectFilter(data.projects);
    }

    const container = svg.select('.container');
    // ... rest of the function remains the same ...

    // Update links
    let link = container.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);

    link.exit().remove();

    link = link.enter().append('line')
        .attr('class', 'link')
        .attr('stroke', d => getLinkColor(d.type))
        .attr('stroke-width', 1)
        .attr('marker-end', 'url(#arrowhead)')
        .merge(link);

    // Update nodes
    let node = container.selectAll('.node')
        .data(nodes, d => d.id);

    node.exit().remove();

    const nodeEnter = node.enter().append('g')
        .attr('class', 'node')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    nodeEnter.append('circle')
        .attr('r', d => d.size)
        .attr('fill', d => d.color)
        .attr('filter', 'url(#glow)')
        .attr('stroke', d => d.color)
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.5);

    nodeEnter.append('text')
        .attr('dy', d => d.size + 12)
        .text(d => d.label);

    node = nodeEnter.merge(node);

    // Interactions
    node.on('mouseover', showTooltip)
        .on('mouseout', hideTooltip)
        .on('click', showNodeDetails);

    // Update simulation with new data
    updateSimulation(link, node);
}

function getLinkColor(type) {
    const colors = {
        'contains': 'rgba(0, 240, 255, 0.3)',
        'executes': 'rgba(255, 170, 0, 0.3)',
        'modifies': 'rgba(255, 204, 0, 0.3)',
        'threw': 'rgba(255, 0, 68, 0.4)'
    };
    return colors[type] || 'rgba(255, 255, 255, 0.2)';
}

function showTooltip(event, d) {
    const tooltip = document.getElementById('tooltip');
    let content = `<div class="tooltip-title">${d.label}</div>`;

    if (d.type === 'project') {
        content += `<div class="tooltip-sub">${d.path}</div>`;
        content += `<div>Sessions: ${d.sessions} | Actions: ${d.actions}</div>`;
    } else if (d.type === 'session') {
        content += `<div class="tooltip-sub">${d.id}</div>`;
        content += `<div>Status: ${d.status} | Agent: ${d.agent}</div>`;
        content += `<div>Model: ${d.model}</div>`;
    } else if (d.type === 'action') {
        content += `<div class="tooltip-sub">${d.tool}</div>`;
        content += `<div>${d.summary}</div>`;
        if (d.status) content += `<div>Status: ${d.status}</div>`;
    } else if (d.type === 'error') {
        content += `<div class="tooltip-sub">${d.message}</div>`;
    } else if (d.type === 'file') {
        content += `<div class="tooltip-sub">${d.path}</div>`;
        content += `<div>Edits: ${d.edits}</div>`;
    }

    tooltip.innerHTML = content;
    tooltip.style.left = (event.pageX + 15) + 'px';
    tooltip.style.top = (event.pageY - 10) + 'px';
    tooltip.style.opacity = 1;
}

function hideTooltip() {
    document.getElementById('tooltip').style.opacity = 0;
}

function showNodeDetails(event, d) {
    const info = document.getElementById('node-info');
    let html = `<span class="type-badge ${d.type}">${d.type}</span>`;
    html += `<h4 style="margin: 8px 0; color: ${d.color}">${d.label}</h4>`;

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

    fields[d.type]?.forEach(f => {
        const val = d[f];
        if (val !== undefined && val !== null) {
            html += `<div class="field"><div class="key">${labels[f] || f}</div><div class="val">${String(val).slice(0, 300)}</div></div>`;
        }
    });

    info.innerHTML = html;

    // Highlight connected nodes
    highlightConnections(d);
}

function highlightConnections(d) {
    const connectedIds = new Set();
    links.forEach(l => {
        if (l.source.id === d.id) connectedIds.add(l.target.id);
        if (l.target.id === d.id) connectedIds.add(l.source.id);
    });

    svg.selectAll('.node')
        .style('opacity', n => n.id === d.id || connectedIds.has(n.id) ? 1 : 0.2);

    svg.selectAll('.link')
        .style('opacity', l => l.source.id === d.id || l.target.id === d.id ? 0.8 : 0.05);
}

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

function flashGraph() {
    const container = document.getElementById('graph-container');
    container.style.boxShadow = 'inset 0 0 100px rgba(0, 240, 255, 0.1)';
    setTimeout(() => {
        container.style.boxShadow = 'none';
    }, 300);
}

function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
}

function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
}

// Update minimap after simulation tick
function updateSimulation(link, node) {
    simulation.nodes(nodes).on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);

        // Update minimap on each tick
        updateMinimap();
    });

    simulation.force('link').links(links);
    simulation.alpha(0.3).restart();
}

// Sparkline functionality
let sparklineData = [];
const MAX_SPARKLINE_POINTS = 30;

function initSparkline() {
    const svg = d3.select('#sparkline');
    const width = 120;
    const height = 30;

    // Add gradient
    const gradient = svg.append('defs')
        .append('linearGradient')
        .attr('id', 'sparkGradient')
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '0%')
        .attr('y2', '100%');

    gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', 'var(--neon-green)')
        .attr('stop-opacity', 0.8);

    gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', 'var(--neon-green)')
        .attr('stop-opacity', 0);

    // Initialize sparkline data
    for (let i = 0; i < MAX_SPARKLINE_POINTS; i++) {
        sparklineData.push(0);
    }

    updateSparkline();
    setInterval(updateSparklineData, 1000);
}

function updateSparklineData() {
    // In a real implementation, this would fetch actual actions data
    // For now, we'll simulate with random values
    const newValue = Math.floor(Math.random() * 10);
    sparklineData.shift();
    sparklineData.push(newValue);
    updateSparkline();
}

function updateSparkline() {
    const svg = d3.select('#sparkline');
    const width = 120;
    const height = 30;

    svg.selectAll('*').remove();

    const x = d3.scaleLinear()
        .domain([0, sparklineData.length - 1])
        .range([0, width]);

    const y = d3.scaleLinear()
        .domain([0, d3.max(sparklineData) || 1])
        .range([height, 0]);

    const line = d3.line()
        .x((d, i) => x(i))
        .y(d => y(d))
        .curve(d3.curveMonotoneX);

    const area = d3.area()
        .x((d, i) => x(i))
        .y0(height)
        .y1(d => y(d))
        .curve(d3.curveMonotoneX);

    // Add area
    svg.append('path')
        .datum(sparklineData)
        .attr('class', 'spark-area')
        .attr('d', area);

    // Add line
    svg.append('path')
        .datum(sparklineData)
        .attr('class', 'spark-line')
        .attr('d', line);

    // Add dot for last point
    const lastPoint = sparklineData[sparklineData.length - 1];
    svg.append('circle')
        .attr('class', 'spark-dot')
        .attr('cx', x(sparklineData.length - 1))
        .attr('cy', y(lastPoint))
        .attr('r', 3);
}

// Filters functionality
let activeFilters = {
    project: true,
    session: true,
    action: true,
    error: true,
    file: true
};
let selectedProject = '';

function initFilters() {
    // Type filters
    document.querySelectorAll('.filter-type').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const type = e.target.dataset.type;
            activeFilters[type] = e.target.checked;
            applyFilters();
        });
    });

    // Project filter
    document.getElementById('project-filter').addEventListener('change', (e) => {
        selectedProject = e.target.value;
        applyFilters();
    });

    // Search
    document.getElementById('search-box').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        searchNodes(term);
    });

    // Reset button
    document.getElementById('btn-reset').addEventListener('click', resetView);
}

function applyFilters() {
    svg.selectAll('.node')
        .classed('dimmed', d => !activeFilters[d.type]);

    svg.selectAll('.link')
        .classed('dimmed', d => {
            const sourceNode = nodes.find(n => n.id === d.source.id || n.id === d.source);
            const targetNode = nodes.find(n => n.id === d.target.id || n.id === d.target);
            return !activeFilters[sourceNode?.type] || !activeFilters[targetNode?.type];
        });

    // Apply project filter if selected
    if (selectedProject) {
        svg.selectAll('.node')
            .classed('dimmed', d => {
                if (!activeFilters[d.type]) return true;
                return d.project !== selectedProject && d.type !== 'project';
            });
    }
}

function updateProjectFilter(projects) {
    const select = document.getElementById('project-filter');
    select.innerHTML = '<option value="">All Projects</option>';

    projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.label;
        select.appendChild(option);
    });
}

function searchNodes(term) {
    if (!term) {
        svg.selectAll('.node').classed('search-match', false);
        return;
    }

    svg.selectAll('.node')
        .classed('search-match', d =>
            d.label.toLowerCase().includes(term) ||
            (d.path && d.path.toLowerCase().includes(term)) ||
            (d.id && d.id.toLowerCase().includes(term))
        );
}

function resetView() {
    // Reset zoom
    svg.transition().duration(750).call(
        d3.zoom().transform,
        d3.zoomIdentity
    );

    // Reset filters
    document.querySelectorAll('.filter-type').forEach(checkbox => {
        checkbox.checked = true;
        const type = checkbox.dataset.type;
        activeFilters[type] = true;
    });

    document.getElementById('project-filter').value = '';
    selectedProject = '';

    document.getElementById('search-box').value = '';

    // Reset node highlighting
    svg.selectAll('.node')
        .classed('dimmed', false)
        .classed('highlighted', false)
        .classed('search-match', false);

    svg.selectAll('.link')
        .classed('dimmed', false);

    // Reset info panel
    document.getElementById('node-info').innerHTML = '<p class="placeholder">Select a node to view details</p>';
}

// Minimap functionality
let minimapSvg, minimapWidth, minimapHeight;

function initMinimap() {
    minimapSvg = d3.select('#minimap');
    const container = document.getElementById('minimap-container');
    minimapWidth = container.clientWidth;
    minimapHeight = container.clientHeight;

    updateMinimap();
}

function updateMinimap() {
    if (!minimapSvg || !nodes.length) return;

    minimapSvg.selectAll('*').remove();

    // Calculate bounds of all nodes
    const xExtent = d3.extent(nodes, d => d.x);
    const yExtent = d3.extent(nodes, d => d.y);

    // Add some padding
    const padding = 50;
    const bounds = {
        x0: xExtent[0] - padding,
        y0: yExtent[0] - padding,
        x1: xExtent[1] + padding,
        y1: yExtent[1] + padding
    };

    // Calculate scale to fit nodes in minimap
    const scale = Math.min(
        minimapWidth / (bounds.x1 - bounds.x0),
        minimapHeight / (bounds.y1 - bounds.y0)
    );

    // Draw nodes on minimap
    minimapSvg.selectAll('.minimap-node')
        .data(nodes)
        .enter()
        .append('circle')
        .attr('class', 'minimap-node')
        .attr('cx', d => (d.x - bounds.x0) * scale)
        .attr('cy', d => (d.y - bounds.y0) * scale)
        .attr('r', d => Math.max(1, d.size * scale / 2))
        .attr('fill', d => d.color)
        .attr('opacity', 0.7);

    // Draw links on minimap
    minimapSvg.selectAll('.minimap-link')
        .data(links)
        .enter()
        .append('line')
        .attr('class', 'minimap-link')
        .attr('x1', d => (d.source.x - bounds.x0) * scale)
        .attr('y1', d => (d.source.y - bounds.y0) * scale)
        .attr('x2', d => (d.target.x - bounds.x0) * scale)
        .attr('y2', d => (d.target.y - bounds.y0) * scale)
        .attr('stroke', 'rgba(255, 255, 255, 0.2)')
        .attr('stroke-width', 0.5);

    // Update viewport indicator
    updateMinimapViewport(bounds, scale);
}

function updateMinimapViewport(bounds, scale) {
    const viewport = document.getElementById('minimap-viewport');
    const graphContainer = document.getElementById('graph-container');

    // Get current transform of main graph
    const transform = d3.zoomTransform(svg.node());

    // Calculate viewport dimensions
    const graphWidth = graphContainer.clientWidth;
    const graphHeight = graphContainer.clientHeight;

    // Calculate visible area in graph coordinates
    const visibleX0 = -transform.x / transform.k;
    const visibleY0 = -transform.y / transform.k;
    const visibleX1 = visibleX0 + graphWidth / transform.k;
    const visibleY1 = visibleY0 + graphHeight / transform.k;

    // Convert to minimap coordinates
    const minimapX0 = (visibleX0 - bounds.x0) * scale;
    const minimapY0 = (visibleY0 - bounds.y0) * scale;
    const minimapX1 = (visibleX1 - bounds.x0) * scale;
    const minimapY1 = (visibleY1 - bounds.y0) * scale;

    // Update viewport indicator
    viewport.style.left = `${minimapX0}px`;
    viewport.style.top = `${minimapY0}px`;
    viewport.style.width = `${minimapX1 - minimapX0}px`;
    viewport.style.height = `${minimapY1 - minimapY0}px`;
}

// Controls functionality
function initControls() {
    // Export PNG
    document.getElementById('btn-export-png').addEventListener('click', exportPNG);

    // Export JSON
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);

    // Toggle theme
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);
}

function exportPNG() {
    // Use html2canvas library that should be included
    if (typeof html2canvas !== 'undefined') {
        html2canvas(document.getElementById('graph-container')).then(canvas => {
            const link = document.createElement('a');
            link.download = `persistence-graph-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    } else {
        alert('html2canvas library not loaded. Cannot export PNG.');
    }
}

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

function toggleTheme() {
    const themeLink = document.getElementById('theme-stylesheet');
    themeLink.disabled = !themeLink.disabled;

    // Save preference to localStorage
    localStorage.setItem('persistence-theme', themeLink.disabled ? 'default' : 'cyberpunk');
}
