// XuViGaN Persistence — LIQUID NODES Graph
// Unique organic design with living connections

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
let ws = null, simulation, svg, width, height;
let nodes = [], links = [];

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ВЫНЕСЕНЫ НАВЕРХ ===
function getLinkColor(type) {
    const colors = {
        'contains': '#33e0ff',
        'executes': '#ffaa00',
        'modifies': '#ffcc00',
        'threw': '#ff3355'
    };
    return colors[type] || '#8899aa';
}

function organicBlobPath(radius) {
    const points = 8;
    const path = [];
    for (let i = 0; i <= points; i++) {
        const angle = (Math.PI * 2 / points) * i;
        const variation = 0.8 + Math.random() * 0.4;
        const r = radius * variation;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        path.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
    }
    return path.join(' ') + ' Z';
}

function createLiquidNode(g, d) {
    g.append('circle')
        .attr('class', 'aura')
        .attr('r', d.size * 2.2)
        .attr('stroke', d.color)
        .attr('fill', 'none')
        .attr('stroke-width', 3)
        .attr('stroke-opacity', 0.15)
        .attr('filter', 'url(#glow)');

    const path = organicBlobPath(d.size);
    g.append('path')
        .attr('class', 'liquid-body')
        .attr('d', path)
        .attr('fill', d.color)
        .attr('opacity', 0.85)
        .attr('stroke', d.color)
        .attr('stroke-width', 2)
        .attr('stroke-opacity', 0.9)
        .attr('filter', 'url(#glow)');

    g.append('circle')
        .attr('class', 'core')
        .attr('r', d.size * 0.35)
        .attr('fill', '#ffffff')
        .attr('opacity', 0.6);

    const bubbles = 3;
    for (let i = 0; i < bubbles; i++) {
        const angle = (Math.PI * 2 / bubbles) * i + Math.random();
        const dist = d.size * (0.4 + Math.random() * 0.3);
        const bx = Math.cos(angle) * dist;
        const by = Math.sin(angle) * dist;

        g.append('circle')
            .attr('cx', bx).attr('cy', by)
            .attr('r', d.size * 0.12)
            .attr('fill', '#ffffff')
            .attr('opacity', 0.3);
    }

    g.append('text')
        .attr('dy', d => d.size + 18)
        .text(d => d.label)
        .attr('font-size', d => Math.max(10, d.size * 0.9));
}

function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
}

function onResize() {
    width = document.getElementById('graph-container').clientWidth;
    height = document.getElementById('graph-container').clientHeight;
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.alpha(0.3).restart();
}

function initGraph() {
    svg = d3.select('#graph');
    width = document.getElementById('graph-container').clientWidth;
    height = document.getElementById('graph-container').clientHeight;

    const defs = svg.append('defs');

    const gradient = defs.append('radialGradient')
        .attr('id', 'node-gradient')
        .attr('cx', '35%').attr('cy', '35%').attr('r', '65%');

    gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', '#ffffff')
        .attr('stop-opacity', 0.9);

    gradient.append('stop')
        .attr('offset', '30%')
        .attr('stop-color', 'rgba(255,255,255,0.4)');

    gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-opacity', 0.2);

    const filter = defs.append('filter')
        .attr('id', 'glow')
        .attr('x', '-50%').attr('y', '-50%')
        .attr('width', '200%').attr('height', '200%');

    filter.append('feGaussianBlur')
        .attr('stdDeviation', '4')
        .attr('result', 'coloredBlur');

    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    const zoom = d3.zoom()
        .scaleExtent([0.2, 5])
        .on('zoom', e => container.attr('transform', e.transform));

    svg.call(zoom);

    const container = svg.append('g').attr('class', 'container');

    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 18).attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 8).attr('markerHeight', 8)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', 'rgba(51,224,255,0.4)');

    simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(d => {
            if (d.type === 'contains') return 100;
            if (d.type === 'executes') return 60;
            if (d.type === 'modifies') return 80;
            return 70;
        }))
        .force('charge', d3.forceManyBody().strength(d => {
            if (d.type === 'project') return -600;
            if (d.type === 'session') return -300;
            return -80;
        }))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.size * 1.8))
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

    ws.onerror = (err) => console.error('WebSocket error:', err);
}

function updateGraph(data) {
    if (!data || !data.nodes) return;

    nodes = data.nodes;
    links = data.links;

    const container = svg.select('.container');

    let link = container.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);

    link.exit().remove();

    link = link.enter().append('line')
        .attr('class', 'link')
        .attr('stroke', d => getLinkColor(d.type))
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.3)
        .attr('marker-end', 'url(#arrowhead)')
        .merge(link);

    let node = container.selectAll('.node')
        .data(nodes, d => d.id);

    node.exit().remove();

    const nodeEnter = node.enter().append('g')
        .attr('class', 'node')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended))
        .style('color', d => d.color);

    nodeEnter.each(function(d) {
        createLiquidNode(d3.select(this), d);
    });

    node = nodeEnter.merge(node);

    node.on('mouseover', showTooltip)
        .on('mouseout', hideTooltip)
        .on('click', showNodeDetails);

    simulation.nodes(nodes).on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    simulation.force('link').links(links);
    simulation.alpha(0.3).restart();
}

// === ОСТАЛЬНОЕ ПОДКЛЮЧАЕТСЯ В КОНЦЕ ===
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
    highlightConnections(d);
}

function highlightConnections(d) {
    const connectedIds = new Set();
    links.forEach(l => {
        if (l.source.id === d.id) connectedIds.add(l.target.id);
        if (l.target.id === d.id) connectedIds.add(l.source.id);
    });

    svg.selectAll('.node')
        .classed('dimmed', n => n.id !== d.id && !connectedIds.has(n.id))
        .classed('highlighted', n => n.id === d.id);

    svg.selectAll('.link')
        .classed('dimmed', l => l.source.id !== d.id && l.target.id !== d.id)
        .classed('highlighted', l => l.source.id === d.id || l.target.id === d.id);
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
        ${detail ? `<div style="color: #8899aa; font-size: 11px;">${detail}</div>` : ''}
    `;

    feed.insertBefore(item, feed.firstChild);
    while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function flashGraph() {
    const container = document.getElementById('graph-container');
    container.style.boxShadow = 'inset 0 0 120px rgba(51, 224, 255, 0.15)';
    setTimeout(() => container.style.boxShadow = 'none', 400);
}

function initControls() {
    document.getElementById('btn-export-png').addEventListener('click', exportPNG);
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('btn-reset').addEventListener('click', resetView);
    document.getElementById('search-box').addEventListener('input', e => searchNodes(e.target.value.toLowerCase()));
}

function exportPNG() {
    if (typeof html2canvas !== 'undefined') {
        html2canvas(document.getElementById('graph-container')).then(canvas => {
            const link = document.createElement('a');
            link.download = `persistence-liquid-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    } else {
        alert('html2canvas not loaded');
    }
}

function exportJSON() {
    const data = { nodes, links, timestamp: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `persistence-liquid-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
}

function resetView() {
    svg.transition().duration(750).call(d3.zoom().transform, d3.zoomIdentity);
    svg.selectAll('.node').classed('dimmed highlighted search-match', false);
    svg.selectAll('.link').classed('dimmed highlighted', false);
    document.getElementById('node-info').innerHTML = '<p class="placeholder">Select a node to view details</p>';
    document.getElementById('search-box').value = '';
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

// === ИНИЦИАЛИЗАЦИЯ ===
document.addEventListener('DOMContentLoaded', () => {
    initGraph();
    connectWebSocket();
    loadStats();
    initControls();
    window.addEventListener('resize', onResize);
});
