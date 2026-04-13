const config = require('./src/config');
const mirCtrl = require('./src/mirController');
const urCtrl = require('./src/urController');
const fs = require('fs');
const path = require('path');
const os = require('os');

// DOM Elements
const elWaypointBox = document.getElementById('waypointCheckboxList');
const mapCanvas = document.getElementById('mapCanvas');

// -----------------------------------------------
// Global States
// -----------------------------------------------
let allWaypoints = [];
let checkedSequence = [];
let checkedSetupMissions = [];
let isPatrollingCheckboxes = false;
let lastMirState = '';
let lastMissionText = '';
let activeErrorCodes = new Set();
let activeDiagnostics = new Set();
window.shared3DViewer = null; // Global shared 3D viewer state
let currentMirStateId = 3; // Tracks real-time MiR state_id

// Map & Localization globals
let globalRobotPosition = { x: 0, y: 0, orientation: 0 };
let globalMapMeta = { r: 0.05, ox: 0, oy: 0, w: 800, h: 800 };
let currentMapId = null;
let mapImgObj = null;

// UR State tracking (received from ROS2 topics)
let urState = { states: '—', error: '—', estop: false };
let isUrManualMode = false;
let isUrEstop = false;
let isUrUnlock = false;
let isUrInitial = false;
let isUrFreedrive = false;
let lidarTileIndex = 0;

let isAdjustMode = false;
let isClickToolActive = false;
let mapPanX = 0, mapPanY = 0;
let mapZoom = 1.0; // Added for CSS Zoom
let isDraggingMap = false, dragStartX, dragStartY;

window.applyMapTransform = () => {
    ['setupMapCanvas', 'lidarCanvasSetup', 'mapCanvas', 'lidarCanvas'].forEach(cid => {
        const c = document.getElementById(cid);
        if (c) {
            c.style.transformOrigin = 'center';
            c.style.transform = `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
        }
    });
    updateMapScaleBar();
};

window.cmdMapZoomIn = () => { mapZoom *= 1.2; applyMapTransform(); };
window.cmdMapZoomOut = () => { mapZoom /= 1.2; applyMapTransform(); };

function updateLED(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `led ${status}`; // 'ok', 'err', 'warn', or ''
}

window.toggleAdjustMode = () => {
    isAdjustMode = !isAdjustMode;
    const btn = document.getElementById('btnAdjustMode');
    const tb = document.getElementById('adjustToolbar');
    if (isAdjustMode) {
        if (btn) btn.classList.add('active');
        if (tb) tb.classList.add('show');
    } else {
        if (btn) btn.classList.remove('active');
        if (tb) tb.classList.remove('show');
        // Reset click tool on exit
        isClickToolActive = false;
        const clickBtn = document.getElementById('btnClickTool');
        if (clickBtn) { clickBtn.style.filter = ''; }
        showToast("Adjust Mode Saved & Closed", "ok");
    }
};

window.toggleClickTool = () => {
    isClickToolActive = !isClickToolActive;
    const btn = document.getElementById('btnClickTool');
    if (btn) {
        btn.style.filter = isClickToolActive ? 'drop-shadow(0 0 5px #00a5e5)' : '';
    }
    if (isClickToolActive) showToast("Click Tool Active: Touch map to set position", "msg");
};

window.toggleRemoteControl = () => {
    const rc = document.getElementById('urRemoteControl');
    const btn = document.getElementById('btnToggleRemote');
    if (!rc) return;

    const isHidden = window.getComputedStyle(rc).display === 'none';
    if (isHidden) {
        rc.style.display = 'flex';
        if (btn) btn.classList.add('active');
        showToast("UR Controller Opened", "msg");
    } else {
        rc.style.display = 'none';
        if (btn) btn.classList.remove('active');
    }
};

window.centerMapOnRobot = () => {
    mapPanX = 0;
    mapPanY = 0;
    mapZoom = 1.0;
    applyMapTransform();
    if (typeof mirCtrl.drawMap === 'function') mirCtrl.drawMap();
};


// Theme Constants
const COLOR_SKY_BLUE = "#00a5e5";
const COLOR_WHITE = "#ffffff";

// Notification System State
let notifications = [];
let unreadCount = 0;
let urdfReqId;

// -----------------------------------------------
// Authentication & Host
// -----------------------------------------------
function getMirHeaders() {
    return mirCtrl.getAuthHeader();
}
function getMirHost() {
    // [CRITICAL FIX] The IP is static. Hardcoded to prevent TypeError when UI element is removed.
    return "192.168.12.20";
}

// -----------------------------------------------
// Tab Switcher
// -----------------------------------------------
// -----------------------------------------------
// Tab Switcher (Ultimate Fix)
// -----------------------------------------------
window.switchTab = (tab) => {
    const tabs = ['setup', 'main', 'mirLog', 'urLog', 'sysLog'];
    tabs.forEach(t => {
        const id = 'tab' + t.charAt(0).toUpperCase() + t.slice(1);
        const btnId = 'tabBtn' + t.charAt(0).toUpperCase() + t.slice(1);
        const elTab = document.getElementById(id);
        const elBtn = document.getElementById(btnId);
        if (elTab) elTab.classList.toggle('active', t === tab);
        if (elBtn) elBtn.classList.toggle('active', t === tab);
    });

    if (window.shared3DViewer && window.shared3DViewer.renderer) {
        let targetId = (tab === 'setup') ? 'urdf-viewer-setup' : (tab === 'main' ? 'urdf-viewer-main' : null);
        if (targetId) {
            const container = document.getElementById(targetId);
            if (container) {
                container.appendChild(window.shared3DViewer.renderer.domElement);
                setTimeout(() => {
                    let w = container.clientWidth;
                    let h = container.clientHeight;
                    if (w > 0 && h > 0) {
                        window.shared3DViewer.renderer.setSize(w, h, false);
                        window.shared3DViewer.camera.aspect = w / h;
                        window.shared3DViewer.camera.updateProjectionMatrix();
                        window.shared3DViewer.controls.update();
                    }
                }, 100);
            }
        }
    }
};

// -----------------------------------------------
// Custom Prompt Modal
// -----------------------------------------------
let promptResolve = null;
window.openCustomPrompt = (defX, defY, defTheta) => {
    return new Promise((resolve) => {
        promptResolve = resolve;
        document.getElementById('promptX').value = defX.toFixed(3);
        document.getElementById('promptY').value = defY.toFixed(3);
        document.getElementById('promptTheta').value = defTheta.toFixed(3);
        document.getElementById('customPromptOverlay').style.display = 'flex';
    });
};
window.closeCustomPrompt = (isOk) => {
    document.getElementById('customPromptOverlay').style.display = 'none';
    if (isOk && promptResolve) {
        promptResolve({
            x: parseFloat(document.getElementById('promptX').value),
            y: parseFloat(document.getElementById('promptY').value),
            theta: parseFloat(document.getElementById('promptTheta').value)
        });
    } else if (promptResolve) {
        promptResolve(null);
    }
    promptResolve = null;
};

// -----------------------------------------------
// Utility Loggers
// -----------------------------------------------
function logMirSystemData(msg, type = "info") {
    ['systemLogSetup', 'systemLogMain'].forEach(id => {
        const sysLog = document.getElementById(id);
        if (!sysLog) return;
        const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const line = document.createElement('div');
        line.className = `ml-line ${type}`;
        line.textContent = `[${ts}] ${msg}`;
        sysLog.prepend(line);
        while (sysLog.children.length > 50) sysLog.removeChild(sysLog.lastChild);
    });
}

function appendLogRow(tbodyId, state, module, msg, timestamp) {
    const s = (state || '').toUpperCase();

    if (tbodyId === 'mirLogTbody') {
        if (!s.includes("ERR") && !s.includes("FAIL") && !s.includes("FATAL") && !s.includes("WARN") && !s.includes("INFO") && !s.includes("STATE") && !s.includes("MISSION")) {
            return;
        }
    }
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const ts = timestamp || new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const tr = document.createElement('tr');

    let lvlClass = "lv-info";
    if (s.includes("ERROR") || s.includes("FATAL") || s.includes("FAIL")) lvlClass = "lv-error";
    else if (s.includes("WARN")) lvlClass = "lv-warn";
    else if (s.includes("STATE") || s.includes("MISSION")) lvlClass = "lv-info";

    tr.innerHTML = `
        <td class="col-lvl ${lvlClass}">${state}</td>
        <td class="col-mod">${module}</td>
        <td class="col-msg">${msg}</td>
        <td class="col-time">${ts}</td>
    `;

    tbody.prepend(tr);
    while (tbody.children.length > 100) tbody.removeChild(tbody.lastChild);

    const scrollContainer = tbody.closest('.log-scroll-area') || tbody.closest('div');
    if (scrollContainer) {
        scrollContainer.scrollTop = 0;
    }
}

// -----------------------------------------------
// Notification & Toast System
// -----------------------------------------------
window.addNotification = (msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    notifications.unshift({ msg, type, ts });
    unreadCount++;
    updateNotificationUI();
};

function updateNotificationUI() {
    const badge = document.getElementById('notificationBadge');
    const list = document.getElementById('notificationList');
    if (!badge || !list) return;

    if (badge) {
        if (unreadCount > 0) {
            badge.innerText = "";
            badge.style.display = 'block';
        } else {
            badge.style.display = 'none';
        }
    }

    if (notifications.length === 0) {
        list.innerHTML = '<div style="padding:15px; color:#aaa; font-size:11px; text-align:center;">No recent notifications.</div>';
    } else {
        list.innerHTML = notifications.map(n => `
            <div class="notification-item ${n.type}">
                <div style="font-weight:700; font-size:10px; opacity:0.6;">${n.ts}</div>
                <div>${n.msg}</div>
            </div>
        `).join('');
    }
}

window.toggleNotificationDropdown = () => {
    const el = document.getElementById('notificationDropdown');
    if (!el) return;
    const isVisible = el.style.display === 'flex';
    el.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible) {
        unreadCount = 0;
        updateNotificationUI();
    }
};

window.clearNotifications = () => {
    notifications = [];
    unreadCount = 0;
    updateNotificationUI();
};

window.updateDashboardErrorState = (isError) => {
    const el = document.getElementById('topic-error-main');
    if (!el) return;
    if (isError) {
        el.textContent = "ERROR";
        el.style.color = "#ff4d4d";
    } else {
        el.textContent = "OK";
        el.style.color = "#4ade80";
    }
};

// -----------------------------------------------
// Unified Logging & Notifications
// -----------------------------------------------
window.logSystemEvent = (msg, level = 'Info', source = 'Local UI') => {
    console.log(`[System] ${level}: ${msg}`);

    // Route to System Logs Table
    const tbody = document.getElementById('rosoutTbody');
    if (tbody) {
        const row = document.createElement('tr');
        const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        row.innerHTML = `
            <td>${now}</td>
            <td style="color: ${level === 'Error' ? '#ff5252' : level === 'Warn' ? '#ff9800' : '#444'}; font-weight:700;">${level}</td>
            <td>${source}</td>
            <td>${msg}</td>
        `;
        tbody.prepend(row);
        if (tbody.rows.length > 100) tbody.deleteRow(100);
    }

    // Auto-Toast & Global Notifications
    if (level === 'Error') {
        showToast(`[System Error] ${msg}`, 'err');
        addNotification(`[${source}] ${msg}`, 'err');
    } else if (level === 'Warn') {
        addNotification(`[${source}] ${msg}`, 'warn');
    }
};

window.showToast = (msg, type = 'msg') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    // Constraint: Limit toastContainer to showing only the newest popup
    container.innerHTML = '';

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${msg}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
};

function logUr(msg) {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const level = msg.includes('[ERROR]') ? 'ERROR' : msg.includes('[WARN]') ? 'WARN' : 'INFO';
    appendLogRow('urLogTbody', level, 'ROS2', msg.replace(/\[[^\]]+\]\s*/g, ''));
}

// -----------------------------------------------
// Save Log (CSV export)
// -----------------------------------------------
window.cmdSaveLog = (tbodyId, filename) => {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (rows.length === 0) return logMirSystemData('저장할 로그가 없습니다.', 'warn');

    let csv = 'Level,Module,Message,Time\n';
    rows.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        const vals = cells.map(td => `"${td.textContent.replace(/"/g, '""')}"`);
        csv += vals.join(',') + '\n';
    });

    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const savePath = path.join(os.homedir(), 'Documents', `${filename}_${ts}.csv`);
        const dir = path.join(os.homedir(), 'Documents');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(savePath, csv, 'utf8');
        logMirSystemData(`로그 저장 완료: ${savePath}`, 'ok');

        addNotification(`Success: Log saved to ${filename}`, 'ok');
    } catch (e) {
        logMirSystemData(`로그 저장 실패: ${e.message}`, 'err');
    }
};

// -----------------------------------------------
// Topic Health Monitor (Setup Tab)
// -----------------------------------------------
function updateTopicStatus(id, isAlive, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isAlive) {
        el.textContent = value || 'Active';
        el.style.color = '#4ade80';
    } else {
        el.textContent = 'Waiting';
        el.style.color = '#aaa';
    }
}

function pollTopicHeartbeats() {
    const hb = urCtrl.lastHeartbeat;
    const now = new Date();
    const alive = (ts, timeout = 5000) => ts && (now - ts) < timeout;

    updateTopicStatus('topic-log-setup', alive(hb.log, 60000), config.ur.logTopic);
    updateTopicStatus('topic-estop-setup', alive(hb.status), config.ur.statusTopic); // Re-labeling Estop topic slot to Status
    updateTopicStatus('topic-joint-setup', alive(hb.joint), config.ur.jointTopic);
    updateTopicStatus('topic-rosout-setup', alive(hb.rosout, 60000), config.ur.rosoutTopic);
    updateTopicStatus('topic-camera-setup', alive(hb.camera), config.ur.cameraTopic);

    // [STRICT LED RULE] Offline = Gray (Class: "")
    const statusAlive = alive(hb.status);
    let urStateColor = '';
    let urStateText = 'OFFLINE';

    if (statusAlive && window.urStatusString) {
        const s = window.urStatusString.toUpperCase();
        if (s === 'LOCKED') {
            urStateColor = 'err'; urStateText = 'LOCKED';
        } else if (s === 'FREEDRIVE') {
            urStateColor = 'warn'; urStateText = 'FREEDRIVE';
        } else if (s === 'UNLOCKED') {
            urStateColor = 'ok'; urStateText = 'UNLOCKED';
        }
    }

    updateLED('led-ur-state', urStateColor);
    updateLED('led-ur-state-main', urStateColor);
    const urMainText = document.getElementById('ur-state-text-main');
    if (urMainText) urMainText.textContent = urStateText;

    // Joint & Camera LEDs
    updateLED('led-ur-joint', alive(hb.joint) ? 'ok' : '');
    updateLED('led-ur-cam', alive(hb.camera) ? 'ok' : '');

    // UR Logs Tab Bindings
    updateLED('log-ur-lock-led', urStateText === 'UNLOCKED' ? 'ok' : (urStateText === 'OFFLINE' ? '' : 'warn'));
    const elUrLock = document.getElementById('log-ur-lock-text');
    if (elUrLock) elUrLock.textContent = urStateText === 'UNLOCKED' ? "UNLOCKED" : (urStateText === 'OFFLINE' ? "OFFLINE" : "LOCKED");

    updateLED('log-ur-estop-led', urStateText === 'LOCKED' ? 'err' : (urStateText === 'OFFLINE' ? '' : 'ok'));
    const elUrEstop = document.getElementById('log-ur-estop-text');
    if (elUrEstop) elUrEstop.textContent = urStateText === 'LOCKED' ? "STOPPED" : (urStateText === 'OFFLINE' ? "—" : "CLEAR");

    updateLED('log-ur-mode-led', urStateText === 'FREEDRIVE' ? 'warn' : (urStateText === 'OFFLINE' ? '' : 'ok'));
    const elUrMode = document.getElementById('log-ur-mode-text');
    if (elUrMode) elUrMode.textContent = urStateText === 'FREEDRIVE' ? "FREEDRIVE" : (urStateText === 'OFFLINE' ? "—" : "NORMAL");
}

// -----------------------------------------------
// LiDAR Scan & Robot Position Visualizer
// -----------------------------------------------

const customArrowImg = new Image();
customArrowImg.src = 'images/nav_arrow.png';

async function fetchProtectiveScanAPI() {
    if (!currentMapId || !mapImgObj) return;

    const isSetup = document.getElementById('tabSetup').classList.contains('active');
    const chkLidar = document.getElementById(isSetup ? 'chkLidarSetup' : 'chkLidar');
    if (!chkLidar || !chkLidar.checked) {
        if (typeof drawProtectiveScanOverlay === 'function') drawProtectiveScanOverlay(null);
        return;
    }

    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        const url = `http://${host}/robot-images/laser_map/laser_map_${lidarTileIndex}.png?t=${Date.now()}`;

        const res = await fetch(url, {
            headers: { ...headers, 'Accept': 'image/png' },
            cache: 'no-store'
        });

        if (res.ok) {
            const blob = await res.blob();
            const imgUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                if (typeof drawProtectiveScanOverlay === 'function') drawProtectiveScanOverlay(img);
                URL.revokeObjectURL(imgUrl);
            };
            img.onerror = () => {
                if (typeof drawProtectiveScanOverlay === 'function') drawProtectiveScanOverlay(null);
            };
            img.src = imgUrl;

            lidarTileIndex = (lidarTileIndex + 1) % 20;
        } else {
            if (typeof drawProtectiveScanOverlay === 'function') drawProtectiveScanOverlay(null);
        }
    } catch (e) {
        if (typeof drawProtectiveScanOverlay === 'function') drawProtectiveScanOverlay(null);
    }
}

function drawProtectiveScanOverlay(img) {
    ['lidarCanvas', 'lidarCanvasSetup'].forEach(id => {
        const cvs = document.getElementById(id);
        if (!cvs) return;

        const isSetup = id.includes('Setup');
        const chkGrid = document.getElementById(isSetup ? 'chkGridSetup' : 'chkGrid');
        const chkLidar = document.getElementById(isSetup ? 'chkLidarSetup' : 'chkLidar');

        if (mapImgObj) {
            if (cvs.width !== mapImgObj.width || cvs.height !== mapImgObj.height) {
                cvs.width = mapImgObj.width;
                cvs.height = mapImgObj.height;
            }
        }

        const ctx = cvs.getContext('2d');
        ctx.clearRect(0, 0, cvs.width, cvs.height);

        const r = globalMapMeta.r || 0.05;
        const ox = globalMapMeta.ox || 0;
        const oy = globalMapMeta.oy || 0;

        if (chkGrid && chkGrid.checked) {
            ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
            ctx.lineWidth = 0.5;
            const pixelsPerMeter = 1.0 / r;
            const gridOffset = (ox % 1.0) / r;
            const yOffset = (oy % 1.0) / r;

            ctx.beginPath();
            for (let x = -gridOffset; x < cvs.width; x += pixelsPerMeter) {
                ctx.moveTo(x, 0); ctx.lineTo(x, cvs.height);
            }
            for (let y = cvs.height + yOffset; y > 0; y -= pixelsPerMeter) {
                ctx.moveTo(0, y); ctx.lineTo(cvs.width, y);
            }
            ctx.stroke();
        }

        if (mapImgObj) {
            const rx = (globalRobotPosition.x - ox) / r;
            const ry = mapImgObj.height - ((globalRobotPosition.y - oy) / r);
            const rad = globalRobotPosition.orientation * (Math.PI / 180);

            ctx.save();
            ctx.translate(rx, ry);
            ctx.rotate(-rad);

            if (img && chkLidar && chkLidar.checked) {
                ctx.save();
                // [CRITICAL FIX] Corrected the 90-degree clockwise offset by rotating -90 degrees (-Math.PI / 2)
                ctx.rotate(-Math.PI / 12);

                // ctx.scale(-1, 1);

                const scanRes = 0.05;
                const scale = scanRes / r;
                ctx.drawImage(img, (-img.width / 2) * scale, (-img.height / 2) * scale, img.width * scale, img.height * scale);

                ctx.restore();
            }

            if (customArrowImg.complete && customArrowImg.naturalHeight !== 0) {
                const iconSize = 40;
                ctx.save();
                ctx.rotate(Math.PI / 2);
                ctx.drawImage(customArrowImg, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
                ctx.restore();
            } else {
                ctx.fillStyle = '#4285F4';
                ctx.beginPath(); ctx.arc(0, 0, 12, 0, 2 * Math.PI); ctx.fill();
            }
            ctx.restore();
        }
    });
}

window.toggleLidar = (which, visible) => { };

// -----------------------------------------------
// Map Rendering
// -----------------------------------------------
window.cmdRefreshSetupMap = async () => {
    logMirSystemData("맵 새로고침 중...", "info");
    try {
        const host = getMirHost();
        const headers = getMirHeaders();

        const statRes = await fetch(`http://${host}/api/v2.0.0/status`, { headers });
        if (!statRes.ok) throw new Error(`Status ${statRes.status}`);
        const stat = await statRes.json();

        if (!stat.map_id) return logMirSystemData("활성화된 맵이 없습니다.", "warn");
        currentMapId = stat.map_id;

        await mirCtrl.updatePositions(currentMapId);

        const mapDataRes = await fetch(`http://${host}/api/v2.0.0/maps/${currentMapId}`, { headers });
        if (!mapDataRes.ok) throw new Error(`Map Data ${mapDataRes.status}`);
        const mapData = await mapDataRes.json();

        mirCtrl.map.currentId = currentMapId;

        globalMapMeta.r = mapData.resolution || 0.05;
        globalMapMeta.ox = mapData.origin_x || 0;
        globalMapMeta.oy = mapData.origin_y || 0;

        mirCtrl.map.resolution = globalMapMeta.r;
        mirCtrl.map.originX = globalMapMeta.ox;
        mirCtrl.map.originY = globalMapMeta.oy;

        const b64Raw = mapData.map || mapData.base_map;
        if (b64Raw) {
            const b64 = b64Raw.includes(',') ? b64Raw.split(',')[1] : b64Raw;
            const img = new Image();
            img.src = "data:image/png;base64," + b64;
            img.onload = () => {
                mapImgObj = img;
                globalMapMeta.w = img.width;
                globalMapMeta.h = img.height;

                mirCtrl.map.baseImage = img;
                mirCtrl.drawMap();
                logMirSystemData(`맵 렌더링 완료`, "ok");
            };
        }

        updateWaypointCheckboxes();
        updateMirPositionsList();
        updateMapScaleBar();

    } catch (e) {
        logMirSystemData(`맵 갱신 실패: ${e.message}`, "err");
    }
};

// -----------------------------------------------
// Map Scale Bar Logic
// -----------------------------------------------
function updateMapScaleBar() {
    const res = globalMapMeta.r || 0.05;
    // Apply CSS mapZoom to physical scale ratio
    const pixelsPerMeter = (1.0 / res) * (typeof mapZoom !== 'undefined' ? mapZoom : 1.0);

    let displayMeters = 1;
    let barWidth = pixelsPerMeter;

    if (barWidth < 40) {
        displayMeters = 2;
        barWidth = pixelsPerMeter * 2;
    } else if (barWidth > 200) {
        displayMeters = 0.5;
        barWidth = pixelsPerMeter * 0.5;
    }

    ['scaleLineMain', 'scaleLineSetup'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.width = `${barWidth}px`;
    });

    ['scaleLabelMain', 'scaleLabelSetup'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = `${displayMeters}m`;
    });
}

// -----------------------------------------------
// MiR Status Polling (main loop)
// -----------------------------------------------
let lastFetchedErrorId = -1;
let lastFetchedMissionId = -1;
let lastFetchedSysLogId = -1;
let lastActiveErrorsCount = 0;
let lastMissionQueueState = '';

window.pollDetailedLogs = () => {
    const host = getMirHost();
    const headers = getMirHeaders();

    (async () => {
        try {
            const statRes = await fetch(`http://${host}/api/v2.0.0/status`, { headers });
            if (statRes.ok) {
                const stat = await statRes.json();
                if (stat.position) globalRobotPosition = stat.position;
                if (stat.map_id && stat.map_id !== currentMapId) {
                    currentMapId = stat.map_id;
                    window.cmdRefreshSetupMap();
                }

                if (stat.state_text !== lastMirState || stat.mission_text !== lastMissionText) {
                    lastMirState = stat.state_text;
                    lastMissionText = stat.mission_text;
                    logMirSystemData(`상태 변경: ${stat.state_text} (${stat.mission_text || 'Idle'})`, 'info');

                    // [NEW] Update Active Waypoint/Mission Text in Main Dashboard
                    const activeTextEl = document.getElementById('activeMissionText');
                    if (activeTextEl) {
                        activeTextEl.innerText = stat.mission_text || (stat.state_text === 'Ready' ? 'Standby' : stat.state_text);
                    }
                }

                const activeErrors = stat.errors || [];
                // Route MiR API errors to System Logs
                if (activeErrors.length > 0) {
                    activeErrors.forEach(err => {
                        logSystemEvent(`MiR Error [${err.code}]: ${err.description}`, 'Error');
                    });
                }

                // [FIX] Correct parsing of MiR model name
                const modelEl = document.getElementById('log-mir-model');
                if (modelEl) {
                    modelEl.innerText = stat.robot_name || stat.robot_model || "MiR AMR";
                }

                // Sync global state safely
                currentMirStateId = stat.state_id;

                // [FIX] Declare mirStateColor based on real-time state and errors
                let mirStateColor = 'ok';
                if (stat.state_id === 4) mirStateColor = 'warn';
                else if (stat.state_id >= 10 || activeErrors.length > 0) mirStateColor = 'err';
                else if (stat.state_id === 3 || stat.state_id === 5) mirStateColor = 'ok';

                updateLED('led-mir-state', mirStateColor);
                updateLED('led-mir-state-main', mirStateColor);

                // [FIX] Explicit Play/Pause LED: Green (ok) if Executing/Ready, Yellow (warn) if Paused/Other
                updateLED('led-mir-play', (stat.state_id === 3 || stat.state_id === 5) ? 'ok' : 'warn');

                const isMissionActive = stat.mission_text && stat.mission_text !== 'None' && stat.mission_text !== '...';
                updateLED('led-mir-miss', isMissionActive ? 'ok' : '');

                const mirMainText = document.getElementById('mir-state-text-main');
                if (mirMainText) mirMainText.textContent = stat.state_text || 'Unknown';

                updateLED('led-mir-err', activeErrors.length > 0 ? 'err' : 'ok');

                activeErrors.forEach(err => {
                    const code = err.code || 0;
                    if (!activeErrorCodes.has(code)) {
                        activeErrorCodes.add(code);
                        const msg = `[에러 ${code}] ${err.module}: ${err.description}`;
                        logMirSystemData(msg, 'err');
                        addNotification(msg, 'err');
                    }
                });

                const currentErrorCodes = new Set(activeErrors.map(e => e.code));
                activeErrorCodes.forEach(code => {
                    if (!currentErrorCodes.has(code)) activeErrorCodes.delete(code);
                });
            }
        } catch (e) { }
    })();

    (async () => {
        try {
            const missRes = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { headers });
            if (missRes.ok) {
                const missions = await missRes.json();
                if (Array.isArray(missions)) {
                    const activeQueueSummary = missions.filter(m => {
                        const st = (m.state || '').toUpperCase();
                        return st === 'PENDING' || st === 'EXECUTING' || st === 'STARTING';
                    });

                    // Add LED logic for Mission
                    updateLED('led-mir-miss', activeQueueSummary.length > 0 ? 'ok' : '');


                    const detailedActiveQueue = [];
                    for (const m of activeQueueSummary) {
                        try {
                            const dRes = await fetch(`http://${host}/api/v2.0.0/mission_queue/${m.id}`, { headers });
                            if (dRes.ok) {
                                detailedActiveQueue.push(await dRes.json());
                            }
                        } catch (err) { }
                    }

                    const elState = document.getElementById('mirMissionQueueState');
                    if (elState) {
                        if (activeQueueSummary.length === 0) {
                            elState.innerText = "—";
                            elState.style.color = "#666";
                            if (lastMissionQueueState !== 'None') {
                                logMirSystemData("모든 임무가 종료되었습니다.", "info");
                                lastMissionQueueState = 'None';
                            }
                        } else {
                            const m = activeQueueSummary[0];
                            const st = (m.state || "PENDING").toUpperCase();
                            elState.innerText = `${st} (ID: ${m.id})`;
                            elState.style.color = st === "EXECUTING" ? "#4ade80" : "#ffcc00";
                            if (lastMissionQueueState !== `${m.id}-${st}`) {
                                logMirSystemData(`임무 진행 중: ID ${m.id} - ${st}`, "info");
                                lastMissionQueueState = `${m.id}-${st}`;
                            }
                        }
                    }

                    if (missions.length > 0) {
                        if (lastFetchedMissionId === -1) {
                            lastFetchedMissionId = Math.max(...missions.map(m => m.id || 0));
                        } else {
                            const newMissions = missions.filter(m => (m.id || 0) > lastFetchedMissionId);
                            if (newMissions.length > 0) {
                                lastFetchedMissionId = Math.max(...newMissions.map(m => m.id || 0));
                                for (const m of newMissions) {
                                    try {
                                        const detailRes = await fetch(`http://${host}/api/v2.0.0/mission_queue/${m.id}`, { headers });
                                        if (detailRes.ok) {
                                            const detail = await detailRes.json();
                                            const state = detail.state || 'Unknown';
                                            let missionName = mirCtrl.getMissionName ? mirCtrl.getMissionName(detail.mission_id) : null;
                                            if (!missionName) missionName = (detail.mission_id || 'Unknown').substring(0, 8);
                                            const source = missionName;
                                            const message = (detail.message || 'No message').substring(0, 40);
                                            const timeStr = detail.finished || detail.started || new Date().toLocaleTimeString('ko-KR', { hour12: false });
                                            appendLogRow('mirLogTbody', `MISSION ${state}`, source, message, timeStr);
                                        }
                                    } catch (e) { }
                                }
                            }
                        }
                    }

                    if (typeof window.syncMissionQueueUI === 'function') {
                        window.syncMissionQueueUI(detailedActiveQueue);
                    }
                }
            }
        } catch (e) { }
    })();
    updateWaypointHighlighting();
};

window.syncMissionQueueUI = function (activeQueue) {
    const box = document.getElementById('mirMissionListSetup');
    if (!box) return;

    const activeMissionGuids = new Set(activeQueue.map(m => {
        const parts = String(m.mission_id || m.mission || '').split('/');
        return parts[parts.length - 1];
    }));

    const rows = box.querySelectorAll('label.waypoint-item');
    rows.forEach(row => {
        const chk = row.querySelector('input[type="checkbox"]');
        if (!chk) return;
        const guid = chk.value;

        if (activeMissionGuids.has(guid)) {
            row.classList.add('in-queue-mission');
            chk.disabled = true;
            chk.checked = false;
        } else {
            row.classList.remove('in-queue-mission');
            chk.disabled = false;
        }
    });
};

function updateWaypointHighlighting() {
    if (!mirCtrl.map || !mirCtrl.map.waypoints || !globalRobotPosition) return;

    const tolerance = 0.6;
    let activeWp = null;

    // 1. Find by Name (from active mission text) or Distance
    const missionName = (lastMissionText || "").toLowerCase();
    mirCtrl.map.waypoints.forEach(wp => {
        const dx = globalRobotPosition.x - wp.pos_x;
        const dy = globalRobotPosition.y - wp.pos_y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Match by name in mission text OR proximity
        if ((wp.name && missionName.includes(wp.name.toLowerCase())) || dist < tolerance) {
            activeWp = wp;
        }
    });

    // 2. Update Status Text & LED
    const statusTextEl = document.getElementById('activeWaypointText');
    const statusLedEl = document.getElementById('led-waypoint-active');
    if (statusTextEl) statusTextEl.innerText = activeWp ? activeWp.name : 'Standby';
    if (statusLedEl) updateLED('led-waypoint-active', activeWp ? 'ok' : 'err');

    // 3. Highlight and SORT to top in Main Dashboard List
    ['mirPositionsList', 'mirPositionsListMain'].forEach(id => {
        const posList = document.getElementById(id);
        if (!posList) return;

        const items = posList.querySelectorAll('.waypoint-item');
        items.forEach(item => {
            const isMatch = activeWp && item.dataset.guid === activeWp.guid;
            if (isMatch) {
                item.classList.add('active-item');
                // [CRITICAL] Sort to top only for the Main Dashboard list
                if (id === 'mirPositionsListMain') posList.prepend(item);
            } else {
                item.classList.remove('active-item');
            }
        });
    });
}

window.fetchAndRenderUserMissions = async () => {
    const box = document.getElementById('mirMissionListSetup');
    if (!box) return;
    try {
        const url = `http://${getMirHost()}/api/v2.0.0/missions`;
        const res = await fetch(url, { headers: getMirHeaders() });
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const missions = await res.json();
        const userMissions = missions.filter(m => {
            const guid = m.guid || '';
            const name = (m.name || '').toUpperCase();
            return !guid.startsWith('mirconst-') && !name.includes('UR');
        });
        box.innerHTML = '';
        checkedSetupMissions = [];
        if (userMissions.length === 0) {
            box.innerHTML = '<div style="padding:10px; color:#aaa; font-size:11px;">표시할 사용자 미션이 없습니다.</div>';
            return;
        }
        userMissions.sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(m => {
            const div = document.createElement('label');
            div.className = 'waypoint-item';
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.value = m.guid;
            // [CRITICAL FIX] Darkened accent-color to force a white checkmark
            chk.style.cssText = 'margin-right:10px;accent-color:#0099d8;';
            chk.onchange = (e) => {
                if (e.target.checked) checkedSetupMissions.push(m.guid);
                else checkedSetupMissions = checkedSetupMissions.filter(g => g !== m.guid);
            };
            const nameSpan = document.createElement('span');
            nameSpan.textContent = m.name || 'Unnamed Mission';
            nameSpan.style.flex = '1';
            div.appendChild(chk);
            div.appendChild(nameSpan);
            box.appendChild(div);
        });
        try {
            const host = getMirHost();
            const res = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { headers: getMirHeaders() });
            if (res.ok) {
                const missions = await res.json();
                const activeQueue = missions.filter(m => m.state === 'Pending' || m.state === 'Executing' || m.state === 'Starting');
                syncMissionQueueUI(activeQueue);
            }
        } catch (e) { }
    } catch (error) {
        box.innerHTML = `<div style="padding:10px; color:#e57373; font-size:11px;">로드 실패: ${error.message}</div>`;
    }
};

function updateMirPositionsList() {
    const lists = ['mirPositionsList', 'mirPositionsListMain'].map(id => document.getElementById(id)).filter(el => el);
    if (lists.length === 0) return;

    const waypoints = mirCtrl.map.waypoints || [];
    const chargers = mirCtrl.map.chargers || [];
    const allPos = [
        ...waypoints.map(w => ({ ...w, icon: '📍', label: 'Waypoint' })),
        ...chargers.map(c => ({ ...c, icon: '🔋', label: 'Charger' }))
    ];

    lists.forEach(elList => {
        elList.innerHTML = '';
        if (allPos.length === 0) {
            elList.innerHTML = '<div style="padding:10px; color:#666;">No positions found.</div>';
            return;
        }
        allPos.forEach(p => {
            const item = document.createElement('div');
            item.className = 'waypoint-item';
            item.dataset.guid = p.guid;
            item.dataset.name = p.name; // Added for name matching
            item.innerHTML = `<span>${p.icon} ${p.name || 'Unnamed'}</span><span style="font-size:9px; color:#555;">${p.label}</span>`;
            elList.appendChild(item);
        });
    });
}

function updateWaypointCheckboxes() {
    const currentWps = mirCtrl.map.waypoints || [];
    if (allWaypoints.length !== currentWps.length) {
        allWaypoints = currentWps;
        if (elWaypointBox) elWaypointBox.innerHTML = '';
        checkedSequence = [];
        allWaypoints.forEach(wp => {
            const div = document.createElement('label');
            div.className = "waypoint-item";
            const chk = document.createElement('input');
            chk.type = "checkbox";
            chk.value = wp.guid;
            chk.onchange = (e) => handleCheckboxChange(e.target, wp.guid);
            div.appendChild(chk);
            div.appendChild(document.createTextNode(wp.name || 'Unknown'));
            if (elWaypointBox) elWaypointBox.appendChild(div);
        });
    }
}

function handleCheckboxChange(checkboxElem, guid) {
    if (checkboxElem.checked) {
        if (!checkedSequence.includes(guid)) checkedSequence.push(guid);
    } else {
        checkedSequence = checkedSequence.filter(g => g !== guid);
    }
}

window.cmdScenario = (id) => {
    if (typeof urCtrl.publishScenarioById === 'function') {
        urCtrl.publishScenarioById(id);
        logSystemEvent(`Scenario ${id} Triggered`, "Info");
        showToast(`Scenario ${id} Triggered`, "msg");
    }
};

window.cmdRunCheckedWaypoints = async () => {
    if (checkedSequence.length === 0) return logMirSystemData("실행 실패: 선택된 웨이포인트가 없습니다.", "err");
    for (const guid of checkedSequence) {
        await mirCtrl.postMission(mirCtrl.missions.moveGuid, guid);
    }
};

window.cmdTogglePatrolCheckbox = () => {
    isPatrollingCheckboxes = !isPatrollingCheckboxes;
    const btn = document.getElementById('btnPatrol');
    if (isPatrollingCheckboxes) {
        if (checkedSequence.length === 0) { isPatrollingCheckboxes = false; return alert("체크된 웨이포인트가 없습니다."); }
        if (btn) { btn.innerText = "Stop Patrol"; btn.style.borderColor = "#c62828"; }
        window.cmdRunCheckedWaypoints();
    } else {
        if (btn) { btn.innerText = "Patrol"; btn.style.borderColor = ""; }
    }
};

// [CRITICAL FIX] Safe toggle avoiding invalid states
window.cmdMirPlay = () => {
    urCtrl.publishBoolValue(config.ur.mirPlayTopic, true);
    logSystemEvent("MiR Play Command Sent (ROS2)", "Info");
};

window.cmdMirPause = () => {
    urCtrl.publishBoolValue(config.ur.mirPlayTopic, false);
    logSystemEvent("MiR Pause Command Sent (ROS2)", "Warn");
};

window.cmdMirDock = () => {
    if (mirCtrl.missions.dockGuid) {
        const charger = (mirCtrl.map.chargers && mirCtrl.map.chargers.length > 0) ? mirCtrl.map.chargers[0].guid : null;
        mirCtrl.postMission(mirCtrl.missions.dockGuid, charger);
        logSystemEvent("도킹 (Dock) 명령 전송", "Info");
    }
};

window.cmdMirCancel = async () => {
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ clear_error: true }) });
        await new Promise(r => setTimeout(r, 100));
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 4 }) });
        logSystemEvent("미션 취소 (Cancel) 명령 전송", "Warn");
        showToast("Mission Cancelled", "warn");
    } catch (e) { }
};

window.cmdMirClearErr = async () => {
    try {
        const res = await fetch(`http://${getMirHost()}/api/v2.0.0/status`, { method: 'PUT', headers: getMirHeaders(), body: JSON.stringify({ clear_error: true }) });
        if (res.ok) {
            logSystemEvent("에러 초기화 (Clear) 명령 전송", "Info");
            showToast("Errors cleared", "ok");
        }
    } catch (e) { }
};

window.cmdAddMissionToQueue = async () => {
    if (checkedSetupMissions.length === 0) return alert('추가할 미션을 체크해주세요.');

    /* [LEGACY REST API LOGIC - Commented Out]
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        const statRes = await fetch(`http://${host}/api/v2.0.0/status`, { headers });
        if (statRes.ok) {
            const stat = await statRes.json();
            if (stat.state_id !== 3 && stat.state_id !== 4) {
                await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 3 }) });
                await new Promise(r => setTimeout(r, 800));
            }
        }

        let successCount = 0;
        let failCount = 0;
        for (const guid of checkedSetupMissions) {
            const res = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { method: 'POST', headers, body: JSON.stringify({ mission_id: guid }) });
            if (res.ok) successCount++;
            else failCount++;
        }

        if (successCount > 0) logMirSystemData(`미션 ${successCount}개가 큐에 추가되었습니다.`, 'ok');
        if (failCount > 0) logMirSystemData(`미션 ${failCount}개 추가 실패 (로봇 상태 확인)`, 'err');

        checkedSetupMissions = [];
        window.pollDetailedLogs();
        setTimeout(() => { window.pollDetailedLogs(); }, 1000);
        setTimeout(() => { window.pollDetailedLogs(); }, 2000);

    } catch (e) {
        logMirSystemData(`미션 추가 중 오류: ${e.message}`, "err");
    }
    */

    // [NEW] ROS2 Topic Migration
    urCtrl.publishBoolTrigger(config.ur.mirAddTopic);
    logSystemEvent("MiR Add Mission Command Sent (ROS2)", "Info");
    showToast("Mission Add Triggered", "msg");
};

window.cmdClearMissionQueue = async () => {
    /* [LEGACY REST API LOGIC - Commented Out]
    if (confirm("정말로 미션 큐를 모두 삭제하시겠습니까?")) {
        try {
            const res = await fetch(`http://${getMirHost()}/api/v2.0.0/mission_queue`, { method: 'DELETE', headers: getMirHeaders() });
            if (res.ok) logMirSystemData("미션 큐가 모두 삭제되었습니다.", "warn");
        } catch (e) { }
    }
    */

    // [NEW] ROS2 Topic Migration
    urCtrl.publishBoolTrigger(config.ur.mirClearTopic);
    logSystemEvent("MiR Clear Mission Command Sent (ROS2)", "Warn");
    showToast("Mission Clear Triggered", "warn");
};

// -----------------------------------------------
// UR Control Buttons (Toggle / Fire & Forget)
// -----------------------------------------------

window.cmdUrManualMode = () => {
    // Kept for logical consistency, though removed from HTML
    isUrManualMode = !isUrManualMode;
    const el = document.getElementById('topic-states-main');
    if (el) {
        el.textContent = isUrManualMode ? "MANUAL" : "AUTO";
        el.style.color = isUrManualMode ? COLOR_SKY_BLUE : "#4ade80";
    }
    if (typeof urCtrl.publishManualMode === 'function') urCtrl.publishManualMode(isUrManualMode);
};

window.cmdUrLock = () => {
    if (typeof urCtrl.publishLock === 'function') urCtrl.publishLock(true);
    logSystemEvent("로봇 잠금 (Lock) 명령 전송", "Info");
    showToast("Command Sent: UR LOCK (true)", "msg");
};

window.cmdUrUnlock = () => {
    if (typeof urCtrl.publishLock === 'function') urCtrl.publishLock(false);
    logSystemEvent("로봇 잠금 해제 (Unlock) 명령 전송", "Info");
    showToast("Command Sent: UR UNLOCK (false)", "msg");
};

window.cmdUrEstop = () => {
    if (typeof urCtrl.publishLock === 'function') urCtrl.publishLock(true);
    logSystemEvent("비상 정지 (E-Stop) 명령 전송", "Error");
    showToast("E-Stop ENGAGED: UR Locked", "msg");
};

window.cmdUrFreedrive = () => {
    isUrFreedrive = !isUrFreedrive;
    if (typeof urCtrl.publishFreedrive === 'function') urCtrl.publishFreedrive(isUrFreedrive);
    logSystemEvent(`리드스루 (Freedrive) 모드 ${isUrFreedrive ? '진입' : '해제'}`, "Info");
    showToast("Freedrive: " + (isUrFreedrive ? "ON" : "OFF"), "msg");
    const btns = document.querySelectorAll('button[onclick="cmdUrFreedrive()"]');
    btns.forEach(btn => {
        btn.style.backgroundColor = isUrFreedrive ? COLOR_SKY_BLUE : COLOR_WHITE;
        btn.style.color = isUrFreedrive ? COLOR_WHITE : COLOR_SKY_BLUE;
    });
};

window.cmdSetInitialPosition = () => {
    // Fire & Forget: sends true only
    if (typeof urCtrl.publishInitialPose === 'function') urCtrl.publishInitialPose(true);
    showToast("Command Sent: INITIAL POSITION", "msg");
};

// Direct Adjust Helper (Bypasses the prompt modal)
window.executeMirPositionAdjust = async (x, y, theta) => {
    showToast("Adjusting position...", "msg");
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        // Pause robot and clear errors
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 4, clear_error: true }) });
        await new Promise(r => setTimeout(r, 500));
        // Send new position
        const resPos = await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ position: { x: Number(x), y: Number(y), orientation: Number(theta) } }) });
        if (resPos.ok) {
            await new Promise(r => setTimeout(r, 500));
            // Resume robot
            await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 3 }) });
            logMirSystemData("위치 보정 완료.", "ok");
            showToast("Position Adjusted Successfully", "ok");
        }
    } catch (e) {
        logMirSystemData("위치 보정 실패.", "err");
    }
};

// Auto Adjust: Localize at the current estimated position immediately
window.cmdAutoAdjust = () => {
    const curPos = globalRobotPosition || { x: 0, y: 0, orientation: 0 };
    executeMirPositionAdjust(curPos.x, curPos.y, curPos.orientation);
};

// Map old HTML button call to new functionality
window.cmdAdjustRobotPosition = window.cmdAutoAdjust;

window.cmdCaptureImage = () => {
    const img = document.getElementById('camera-stream-main');
    if (!img || !img.src || !img.src.includes('base64')) return;
    try {
        const base64Data = img.src.replace(/^data:image\/jpeg;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const savePath = path.join(os.homedir(), 'Pictures', `capture_${timestamp}.jpg`);
        const dir = path.join(os.homedir(), 'Pictures');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(savePath, buffer);
        logUr(`[OK] 이미지 저장 완료: ${savePath}`);

        addNotification(`Success: Image captured to Pictures folder`, 'ok');
    } catch (e) { }
};

let globalTargetJoints = {};

// -----------------------------------------------
// ROS 3D Viewer Initialization (With Alert Diagnostics)
// -----------------------------------------------
window.initROS3DViewer = () => {
    if (window.shared3DViewer) return;

    try {
        urCtrl.startJointSubscriber((msg) => {
            if (!msg) return;
            const newJoints = {};
            const jointDOMMap = {
                "shoulder_pan_joint": "log-j-base",
                "shoulder_lift_joint": "log-j-shoulder",
                "elbow_joint": "log-j-elbow",
                "wrist_1_joint": "log-j-wrist1",
                "wrist_2_joint": "log-j-wrist2",
                "wrist_3_joint": "log-j-wrist3"
            };

            if (msg.name && msg.position) {
                for (let i = 0; i < msg.name.length; i++) {
                    newJoints[msg.name[i]] = msg.position[i];
                    if (jointDOMMap[msg.name[i]]) {
                        const deg = (msg.position[i] * (180 / Math.PI)).toFixed(2);
                        const el = document.getElementById(jointDOMMap[msg.name[i]]);
                        if (el) el.innerText = deg;
                    }
                }
            } else if (typeof msg === 'object') {
                for (const key in msg) {
                    newJoints[key] = msg[key];
                    if (jointDOMMap[key]) {
                        const deg = (msg[key] * (180 / Math.PI)).toFixed(2);
                        const el = document.getElementById(jointDOMMap[key]);
                        if (el) el.innerText = deg;
                    }
                }
            }
            if (Object.keys(newJoints).length > 0) {
                globalTargetJoints = newJoints;
                
                // [FIX] Force update robot visual and trigger immediate frame render
                if (window.shared3DViewer && window.shared3DViewer.robot) {
                    for (const name in newJoints) {
                        window.shared3DViewer.robot.setJointValue(name, newJoints[name]);
                    }
                    window.shared3DViewer.renderer.render(window.shared3DViewer.scene, window.shared3DViewer.camera);
                }
                updateLED('led-ur-joint', 'ok');
            }
        });

        // [NEW] Unified UR Status Monitor
        window.urStatusString = "OFFLINE";
        urCtrl.startStatusSubscriber((status) => {
            window.urStatusString = status;
        });

        const jointCalibration = {
            'shoulder_pan_joint': { multiplier: 1, offset: 0 },
            'shoulder_lift_joint': { multiplier: 1, offset: 0 },
            'elbow_joint': { multiplier: 1, offset: 0 },
            'wrist_1_joint': { multiplier: 1, offset: 0 },
            'wrist_2_joint': { multiplier: 1, offset: 0 },
            'wrist_3_joint': { multiplier: 1, offset: 0 }
        };

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0xebebeb, 1);

        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1.0, 0.1, 100);
        camera.position.set(1.5, 1.5, 1.5);
        camera.lookAt(0, 0, 0);

        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.target.set(0, 0, 0);

        const gridHelper = new THREE.GridHelper(2, 20, 0xaaaaaa, 0xdddddd);
        scene.add(gridHelper);
        scene.add(new THREE.AxesHelper(0.5));

        const dLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dLight.position.set(5, 10, 5);
        scene.add(dLight);
        scene.add(new THREE.AmbientLight(0xffffff, 0.4));

        window.shared3DViewer = { renderer, camera, scene, controls, robot: null };

        const activeTabStr = document.querySelector('.tab-btn.active')?.id || 'tabBtnSetup';
        let targetEl = document.getElementById(activeTabStr === 'tabBtnMain' ? 'urdf-viewer-main' : 'urdf-viewer-setup');
        if (targetEl) targetEl.appendChild(renderer.domElement);

        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (window.shared3DViewer && entry.target.contains(window.shared3DViewer.renderer.domElement)) {
                    const { width, height } = entry.contentRect;
                    if (width > 0 && height > 0) {
                        window.shared3DViewer.renderer.setSize(width, height, false);
                        window.shared3DViewer.camera.aspect = width / height;
                        window.shared3DViewer.camera.updateProjectionMatrix();
                        window.shared3DViewer.renderer.render(scene, camera);
                    }
                }
            }
        });

        const elSetup = document.getElementById('urdf-viewer-setup');
        const elMain = document.getElementById('urdf-viewer-main');
        if (elSetup) resizeObserver.observe(elSetup);
        if (elMain) resizeObserver.observe(elMain);

        // [CRITICAL FIX] DYNAMIC LOADER DETECTION + ALERT
        let LoaderClass = null;
        if (typeof URDFLoader !== 'undefined') LoaderClass = URDFLoader;
        else if (typeof window.URDFLoader !== 'undefined') LoaderClass = window.URDFLoader;
        else if (typeof THREE.URDFLoader !== 'undefined') LoaderClass = THREE.URDFLoader;

        if (!LoaderClass) {
            const errorMsg = "[3D Viewer Error] URDFLoader class could not be found. Check your internet connection to the CDN.";
            console.error(errorMsg);
            alert(errorMsg); // Push to OS UI
            return;
        }

        const manager = new THREE.LoadingManager();
        manager.onLoad = () => {
            console.log("[3D Viewer] All meshes parsed and loaded. Aligning camera.");
            if (window.shared3DViewer && window.shared3DViewer.controls) {
                window.shared3DViewer.controls.reset();
                window.shared3DViewer.camera.position.set(1.5, 1.5, 1.5);
                window.shared3DViewer.camera.lookAt(0, 0, 0);
                window.shared3DViewer.controls.target.set(0, 0, 0);
                window.shared3DViewer.controls.update();
            }
        };

        const loader = new LoaderClass(manager);
        loader.packages = { 'ur_description': `file://${__dirname}/src/Universal_Robots_ROS2_Description` };

        const loadRobot = (urdfData) => {
            try {
                const robot = loader.parse(urdfData);
                const rosWrapper = new THREE.Group();
                rosWrapper.rotation.x = -Math.PI / 2;
                rosWrapper.add(robot);
                scene.add(rosWrapper);
                window.shared3DViewer.robot = robot;
            } catch (parseError) {
                const errorMsg = `[3D Viewer Error] Failed to parse URDF file:\n${parseError.message}`;
                console.error(errorMsg);
                alert(errorMsg); // Push to OS UI
            }
        };

        // [CRITICAL FIX] FILE PATH DETECTION + ALERT
        const path1 = path.join(__dirname, 'ur5e.urdf');
        const path2 = path.join(__dirname, 'src', 'ur5e.urdf');

        fs.readFile(path1, 'utf8', (err, data) => {
            if (err) {
                fs.readFile(path2, 'utf8', (err2, data2) => {
                    if (err2) {
                        const errorMsg = `[3D Viewer Error] URDF file could not be found.\nAttempted paths:\n1. ${path1}\n2. ${path2}\nError: ${err2.message}`;
                        console.error(errorMsg);
                        alert(errorMsg); // Push to OS UI
                        return;
                    }
                    loadRobot(data2);
                });
                return;
            }
            loadRobot(data);
        });

        // [CRITICAL FIX] RENDER LOOP DECLARED EXACTLY ONCE
        const renderLoop = () => {
            requestAnimationFrame(renderLoop);
            if (window.shared3DViewer && window.shared3DViewer.controls) {
                const robot = window.shared3DViewer.robot;
                if (robot && Object.keys(globalTargetJoints).length > 0) {
                    for (const jName in globalTargetJoints) {
                        try {
                            const targetPosition = globalTargetJoints[jName];
                            if (typeof targetPosition === 'number' && !isNaN(targetPosition)) {
                                const cal = jointCalibration[jName] || { multiplier: 1, offset: 0 };
                                const finalAngle = (targetPosition * cal.multiplier) + cal.offset;
                                if (typeof robot.setJointValue === 'function') {
                                    robot.setJointValue(jName, finalAngle);
                                } else if (robot.joints && robot.joints[jName]) {
                                    robot.joints[jName].jointValue = finalAngle;
                                }
                            }
                        } catch (jointError) {
                            // Silent catch prevents a missing joint from permanently killing the render loop
                        }
                    }
                }
                window.shared3DViewer.controls.update();
                window.shared3DViewer.renderer.render(window.shared3DViewer.scene, window.shared3DViewer.camera);
            }
        };

        renderLoop(); // Start loop

    } catch (e) {
        const errorMsg = `[3D Viewer Fatal Error] Initialization failed:\n${e.message}`;
        console.error(errorMsg, e);
        alert(errorMsg); // Push to OS UI
    }
};

window.addEventListener('resize', () => {
    if (!window.shared3DViewer) return;
    const activeTabStr = document.querySelector('.tab-btn.active')?.id || 'tabBtnSetup';
    let targetEl = document.getElementById(activeTabStr === 'tabBtnMain' ? 'urdf-viewer-main' : 'urdf-viewer-setup');
    if (targetEl && window.shared3DViewer.renderer) {
        let w = targetEl.clientWidth || 400;
        let h = targetEl.clientHeight || 300;
        window.shared3DViewer.renderer.setSize(w, h, false);
        window.shared3DViewer.camera.aspect = w / h;
        window.shared3DViewer.camera.updateProjectionMatrix();
    }
});

// Manual refresh helper
window.cmdRefresh3DViewer = () => {
    if (window.shared3DViewer && window.shared3DViewer.controls) {
        window.shared3DViewer.controls.reset();
        window.shared3DViewer.camera.position.set(1.5, 1.5, 1.5);
        window.shared3DViewer.camera.lookAt(0, 0, 0);
        window.shared3DViewer.controls.target.set(0, 0, 0);
        window.shared3DViewer.controls.update();
        showToast("3D Viewer Camera Reset", "msg");
    } else {
        window.shared3DViewer = null;
        initROS3DViewer();
        showToast("3D Viewer Initialized", "msg");
    }
};



function startUrStateSubscribers() {
    // Legacy subscriber removed in favor of logical status indicators
}


function wireMapCheckboxes() {
    const wire = (id, field, peerId) => {
        const el = document.getElementById(id);
        if (el) {
            el.onchange = (e) => {
                const checked = e.target.checked;
                mirCtrl[field] = checked;
                if (typeof mirCtrl.drawMap === 'function') mirCtrl.drawMap();

                if (peerId) {
                    const peer = document.getElementById(peerId);
                    if (peer) peer.checked = checked;
                }
            };
        }
    };

    wire('chkWaypoint', 'showWaypoints', 'chkWaypointSetup');
    wire('chkWaypointSetup', 'showWaypoints', 'chkWaypoint');
    wire('chkCharge', 'showChargers', 'chkChargeSetup');
    wire('chkChargeSetup', 'showChargers', 'chkCharge');
    wire('chkLidar', 'showLidar', 'chkLidarSetup');
    wire('chkLidarSetup', 'showLidar', 'chkLidar');
    wire('chkGrid', 'showGrid', 'chkGridSetup');
    wire('chkGridSetup', 'showGrid', 'chkGrid');

    const interaction = (id) => {
        const cvs = document.getElementById(id);
        if (!cvs) return;

        cvs.onmousedown = (e) => {
            isDraggingMap = true;
            dragStartX = e.clientX - mapPanX;
            dragStartY = e.clientY - mapPanY;
        };
        cvs.onmousemove = (e) => {
            if (!isDraggingMap) return;
            mapPanX = e.clientX - dragStartX;
            mapPanY = e.clientY - dragStartY;
            window.applyMapTransform();
        };
        cvs.onmouseup = () => { isDraggingMap = false; };
        cvs.onmouseleave = () => { isDraggingMap = false; };

        // Map Click to Adjust
        cvs.onclick = (e) => {
            if (!mapImgObj) return;

            // [CRITICAL FIX] Made case-insensitive. 'setupMapCanvas' does not contain uppercase 'Setup'
            const isSetup = id.toLowerCase().includes('setup');
            if (isSetup && (!isAdjustMode || !isClickToolActive)) return;

            const rect = cvs.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (cvs.width / rect.width);
            const y = (e.clientY - rect.top) * (cvs.height / rect.height);
            const r = globalMapMeta.r || 0.05, ox = globalMapMeta.ox || 0, oy = globalMapMeta.oy || 0;

            const targetX = x * r + ox;
            const targetY = (cvs.height - y) * r + oy;
            const currentTheta = globalRobotPosition ? globalRobotPosition.orientation : 0;

            if (isSetup) {
                executeMirPositionAdjust(targetX, targetY, currentTheta);
                toggleClickTool(); // Auto-disable the tool after one use
            }
        };
    };
    interaction('mapCanvas'); interaction('setupMapCanvas');
}
function connectMirWebSocket() {
    const host = getMirHost();
    const ws = new WebSocket(`ws://${host}:9090`);

    ws.onopen = () => {
        console.log(`[MiR WebSocket] Connected to ${host}:9090 (Diagnostics Mode)`);

        // Unified Log Subscription
        ws.send(JSON.stringify({
            "op": "subscribe",
            "topic": "/rosout",
            "type": "rosgraph_msgs/Log"
        }));

        // Hardware Health Subscription
        ws.send(JSON.stringify({ "op": "subscribe", "topic": "/diagnostics" }));
        ws.send(JSON.stringify({ "op": "subscribe", "topic": "/diagnostics_agg" }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // 1. Log Routing (/rosout)
            if (data.topic === "/rosout" && data.msg && data.msg.level !== undefined) {
                const log = data.msg;
                let level = "INFO";
                if (log.level === 4) level = "WARN";
                else if (log.level >= 8) level = "ERROR";
                else if (log.level === 1) return;
                const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
                if (typeof appendLogRow === 'function') {
                    appendLogRow('mirLogTbody', level, log.name || 'System', log.msg || '', ts);
                }
            }

            // 2. Hardware Health Mapping (/diagnostics)
            if (data.op === "publish" && (data.topic === "/diagnostics" || data.topic === "/diagnostics_agg")) {
                const statusArr = data.msg.status || [];
                statusArr.forEach(item => {
                    const name = item.name.toLowerCase();
                    const level = item.level; // 0=OK, 1=Warn, 2+=Error, -1=Off
                    const statusClass = (level === 0) ? 'ok' : (level === 1) ? 'warn' : (level === -1) ? '' : 'err';

                    if (name.includes("/computer")) updateLED("hh-computer", statusClass);
                    else if (name.includes("/motors")) updateLED("hh-motors", statusClass);
                    else if (name.includes("/power system")) updateLED("hh-power", statusClass);
                    else if (name.includes("/safety system")) updateLED("hh-safety", statusClass);
                    else if (name.includes("/sensors")) updateLED("hh-sensors", statusClass);
                    else if (name.includes("/serial interface")) updateLED("hh-serial", statusClass);
                });
            }
        } catch (e) {
            console.error("[MiR WebSocket] Error parsing message:", e);
        }
    };

    ws.onclose = () => {
        console.warn("[MiR WebSocket] Disconnected. Retrying in 5s...");
        setTimeout(connectMirWebSocket, 5000);
    };

    ws.onerror = (err) => {
        console.error("[MiR WebSocket] Error:", err);
    };
}


window.onload = () => {
    mirCtrl.init(mapCanvas, null, (state, extra) => {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
        set('mirStateText', state.text || "—");
        set('mirBattery', `${(state.battery || 0).toFixed(1)}%`);

        set('mirRobotNameSetup', state.robot_name || "Unknown");
        set('mirSerialSetup', state.serial_number || "Unknown");

        // [CRITICAL FIX] Safe Battery Time Formatting (H시간 M분)
        const totalSecs = state.battery_time_remaining || 0;
        let timeStr = "—";
        if (totalSecs > 0) {
            const h = Math.floor(totalSecs / 3600);
            const m = Math.floor((totalSecs % 3600) / 60);
            timeStr = h > 0 ? `${h}시간 ${m}분` : `${m}분`;
        }

        set('mirBatteryTime', timeStr);

        // Sync Top Bar Battery Info
        const topBatLevel = document.getElementById('top-battery-level');
        const topBatTime = document.getElementById('top-battery-time');
        if (topBatLevel) topBatLevel.innerText = `${(state.battery || 0).toFixed(1)}%`;
        if (topBatTime) topBatTime.innerText = totalSecs > 0 ? timeStr : "—";

        const upHrs = state.uptime ? Math.floor(state.uptime / 3600) : 0;
        const upMins = state.uptime ? Math.floor((state.uptime % 3600) / 60) : 0;
        set('mirUptime', state.uptime ? `${upHrs}h ${upMins}m` : "—");

        set('mirMoved', state.moved_distance ? `${state.moved_distance.toFixed(2)} m` : "—");
        set('mirErrorCount', state.errors ? state.errors.length : 0);

        globalRobotPosition.x = state.x;
        globalRobotPosition.y = state.y;
        globalRobotPosition.orientation = state.theta;

        if (extra && extra.positionsLoaded) { updateWaypointCheckboxes(); updateMirPositionsList(); }

        // [NEW] Bind Telemetry to Logs Tab
        const setLocal = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
        setLocal('log-mir-sn', state.serial_number || "Unknown");
        setLocal('log-mir-bat', `${(state.battery || 0).toFixed(1)}%`);
        setLocal('log-mir-dist', `${(state.moved_distance || 0).toFixed(2)} m`);
        const logUpMins = state.uptime ? Math.floor(state.uptime / 60) : 0;
        setLocal('log-mir-uptime', `${Math.floor(logUpMins / 60)}h ${logUpMins % 60}m`);
    }, document.getElementById('setupMapCanvas'));

    urCtrl.startLogSubscriber((msg) => {
        if (urCtrl.lastHeartbeat) urCtrl.lastHeartbeat.log = new Date();
        const text = msg.msg || (typeof msg === 'string' ? msg : JSON.stringify(msg));
        const levelCode = msg.level || 2;
        const level = (text.toLowerCase().includes("error") || levelCode >= 8) ? "ERROR" : "INFO";
        const nodeName = msg.name || 'UR_Node';

        // Route UR Errors to System Logs
        if (level === 'ERROR') {
            logSystemEvent(`UR Error: ${text}`, 'Error');
        }

        appendLogRow('urLogTbody', level, nodeName, text);
        updateDashboardErrorState(level === "ERROR");
    });

    urCtrl.startRosoutSubscriber((msg) => {
        if (urCtrl.lastHeartbeat) urCtrl.lastHeartbeat.rosout = new Date();
        const level = msg.toLowerCase().includes("error") ? "ERROR" : "INFO";
        appendLogRow('rosoutTbody', level, 'ros', msg);
    });

    const imgStream = document.getElementById('camera-stream-main');
    urCtrl.startCameraSubscriber((b64) => {
        if (imgStream) {
            imgStream.src = "data:image/jpeg;base64," + b64;
            imgStream.style.display = 'block';
        }
    });

    startUrStateSubscribers();
    wireMapCheckboxes();
    setInterval(pollTopicHeartbeats, 2000);
    setTimeout(() => { window.fetchAndRenderUserMissions(); }, 1500);
    setInterval(() => { window.pollDetailedLogs(); }, 1000);
    setInterval(() => { fetchProtectiveScanAPI(); }, 200);
    connectMirWebSocket();
    initROS3DViewer();
    updateMapScaleBar();
    logUr("[INFO] ROS2 pipeline initialized.");
};