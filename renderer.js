const config = require('./src/config');
const mirCtrl = require('./src/mirController');
const urCtrl = require('./src/urController');
const fs = require('fs');
const path = require('path');
const os = require('os');

// DOM Elements
const elWaypointBox = document.getElementById('waypointCheckboxList');
const elScenarioGrid = document.getElementById('scenarioGrid');
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

// Mission optimistic UI state
let optimisticMissions = new Set();

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
    return document.getElementById('inputHost').value || "192.168.12.20";
}

// -----------------------------------------------
// Tab Switcher
// -----------------------------------------------
window.switchTab = (tab) => {
    document.getElementById('tabSetup').classList.toggle('active', tab === 'setup');
    document.getElementById('tabMain').classList.toggle('active', tab === 'main');
    document.getElementById('tabLogs').classList.toggle('active', tab === 'logs');

    document.getElementById('tabBtnSetup').classList.toggle('active', tab === 'setup');
    document.getElementById('tabBtnMain').classList.toggle('active', tab === 'main');
    document.getElementById('tabBtnLogs').classList.toggle('active', tab === 'logs');

    // [GALAXY BRAIN] Re-parent the shared 3D viewer to the active tab
    if (window.shared3DViewer && window.shared3DViewer.renderer) {
        const targetId = (tab === 'setup') ? 'urdf-viewer-setup' : 'urdf-viewer';
        const container = document.getElementById(targetId);
        if (container) {
            container.appendChild(window.shared3DViewer.renderer.domElement);
        }
    }

    // [DOM TIMING FIX] Trigger 3D viewer resize after a short delay to allow DOM reflow
    setTimeout(() => {
        if (window.shared3DViewer && window.shared3DViewer.renderer) {
            const container = window.shared3DViewer.renderer.domElement.parentElement;
            if (container && container.clientWidth > 0) {
                const w = container.clientWidth;
                const h = container.clientHeight;
                window.shared3DViewer.renderer.setSize(w, h);
                window.shared3DViewer.camera.aspect = w / h;
                window.shared3DViewer.camera.updateProjectionMatrix();
            }
        }
    }, 100);
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
    // REMOVED THE RESTRICTIVE FILTER HERE! All logs (info, ok, warn, err) must pass.
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
    const s = state.toUpperCase();
    
    // Notifications for Critical Errors (Toast removed per requirement)
    if (s.includes("ERROR") || s.includes("FATAL") || s.includes("FAIL")) {
        addNotification(`[ERROR] ${module}: ${msg}`, 'err');
    }

    if (tbodyId === 'mirLogTbody') {
        // Allow tracking of general status updates and events alongside errors
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

    // Badge display logic: Show red dot without numbers when unreadCount > 0
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

window.showToast = (msg, type = 'msg') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;
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

        // Success Notification
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
    // Use 5s for high-frequency topics, 60s for event-driven log topics
    const alive = (ts, timeout = 5000) => ts && (now - ts) < timeout;

    updateTopicStatus('topic-log-setup', alive(hb.log, 60000), config.ur.logTopic);
    // updateTopicStatus('topic-unlock-setup', true, config.ur.unlockTopic); // REMOVE THIS LINE
    updateTopicStatus('topic-estop-setup', true, config.ur.estopTopic);
    updateTopicStatus('topic-joint-setup', alive(hb.joint), config.ur.jointTopic);
    updateTopicStatus('topic-rosout-setup', alive(hb.rosout, 60000), config.ur.rosoutTopic);
    updateTopicStatus('topic-camera-setup', alive(hb.camera), config.ur.cameraTopic);
}

// -----------------------------------------------
// LiDAR Scan & Robot Position Visualizer
// -----------------------------------------------

// [NEW] 유저 커스텀 화살표 이미지 로드
const customArrowImg = new Image();
customArrowImg.src = 'images/nav_arrow.png';

async function fetchProtectiveScanAPI() {
    if (!currentMapId || !mapImgObj) return;

    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        const url = `http://${host}/api/v2.0.0/system/protective_scan`;

        const res = await fetch(url, {
            headers: { ...headers, 'Accept': 'image/png' }
        });

        if (res.ok) {
            const blob = await res.blob();
            const imgUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                drawProtectiveScanOverlay(img);
                URL.revokeObjectURL(imgUrl);
            };
            img.onerror = () => {
                drawProtectiveScanOverlay(null);
            };
            img.src = imgUrl;
        } else {
            drawProtectiveScanOverlay(null);
        }
    } catch (e) {
        drawProtectiveScanOverlay(null);
    }
}

function drawProtectiveScanOverlay(img) {
    ['lidarCanvas', 'lidarCanvasSetup'].forEach(id => {
        const cvs = document.getElementById(id);
        if (!cvs) return;

        const isSetup = id.includes('Setup');
        const chkGrid = document.getElementById(isSetup ? 'chkGridSetup' : 'chkGrid');
        const chkLidar = document.getElementById(isSetup ? 'chkLidarSetup' : 'chkLidar');

        // Always ensure canvas dimensions if possible, but dont return early if mapImgObj is missing
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

        // 1. Draw Grid (Independent of Robot/Map loading)
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

        // 2. Draw Robot & LiDAR Scan (Requiring map context for sizing)
        if (mapImgObj) {
            const rx = (globalRobotPosition.x - ox) / r;
            const ry = mapImgObj.height - ((globalRobotPosition.y - oy) / r);
            const rad = globalRobotPosition.orientation * (Math.PI / 180);

            ctx.save();
            ctx.translate(rx, ry);
            ctx.rotate(-rad);

            // Draw LiDAR Scan ONLY if checkbox is checked
            if (img && chkLidar && chkLidar.checked) {
                const scanRes = 0.05;
                const scale = scanRes / r;
                ctx.drawImage(img, (-img.width / 2) * scale, (-img.height / 2) * scale, img.width * scale, img.height * scale);
            }

            // Draw Robot Arrow
            if (customArrowImg.complete && customArrowImg.naturalHeight !== 0) {
                const iconSize = 40;
                ctx.save(); ctx.rotate(Math.PI / 2);
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

window.toggleLidar = (which, visible) => {
    // [FIX] Toggling LiDAR shouldn't hide the whole canvas, as the Grid is on it.
    // The draw loop now dynamically checks the checkbox state.
};

// -----------------------------------------------
// MiR Diagnostics
// -----------------------------------------------
async function fetchDiagnosticsAPI() {
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        const res = await fetch(`http://${host}/api/v2.0.0/experimental/diagnostics`, { headers });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                data.forEach(diag => {
                    if (diag.level && diag.level > 0) {
                        const levelStr = diag.level === 1 ? "WARN" : "ERROR";
                        const module = diag.name || diag.module || 'Diagnostics';
                        const msg = diag.message || diag.msg || JSON.stringify(diag);
                        const hash = `${module}:${msg}`;
                        if (!activeDiagnostics.has(hash)) {
                            const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
                            appendLogRow('mirLogTbody', levelStr, module, msg, ts);
                            logMirSystemData(`[Event] ${module}: ${msg}`, levelStr === "ERROR" ? "err" : "warn");
                            activeDiagnostics.add(hash);
                            setTimeout(() => { activeDiagnostics.delete(hash); }, 30000);
                        }
                    }
                });
            }
        }
    } catch (e) { }
}

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

        // LET MIR CONTROLLER FETCH DETAILED POSITIONS (WITH X,Y COORDINATES)
        await mirCtrl.updatePositions(currentMapId);

        const mapDataRes = await fetch(`http://${host}/api/v2.0.0/maps/${currentMapId}`, { headers });
        if (!mapDataRes.ok) throw new Error(`Map Data ${mapDataRes.status}`);
        const mapData = await mapDataRes.json();

        mirCtrl.map.currentId = currentMapId;

        // [CRITICAL FIX] Sync metadata to BOTH renderer and the drawing controller
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
                mirCtrl.drawMap(); // Will now calculate px/py perfectly
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
    // We want a bar representing 1 meter
    const pixelsPerMeter = 1.0 / res;
    
    // Choose a reasonable length (e.g., if 1m is too short, show 2m)
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
// MiR Status Polling (main loop) - 실시간 전용
// -----------------------------------------------
let lastFetchedErrorId = -1;
let lastFetchedMissionId = -1;
let lastFetchedSysLogId = -1;
let lastActiveErrorsCount = 0;
let lastMissionQueueState = '';

window.pollDetailedLogs = () => {
    const host = getMirHost();
    const headers = getMirHeaders();

    // 1. Status Polling (Independent)
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
                    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
                    const missionTxt = stat.mission_text ? stat.mission_text.substring(0, 40) : 'Idle';
                    appendLogRow('mirLogTbody', 'STATE', 'System', `[${stat.state_text}] ${missionTxt}`, ts);
                    if (stat.state_text !== lastMirState) {
                        logMirSystemData(`상태 변경: ${stat.state_text}`, 'info');
                    }
                    lastMirState = stat.state_text;
                    lastMissionText = stat.mission_text;
                }

                const activeErrors = stat.errors || [];
                if (activeErrors.length !== lastActiveErrorsCount && activeErrors.length > 0) {
                    const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
                    activeErrors.forEach(err => {
                        appendLogRow('mirLogTbody', 'ERROR', err.module || 'Unknown', err.description || 'No description', ts);
                    });
                    lastActiveErrorsCount = activeErrors.length;
                } else if (activeErrors.length === 0) {
                    lastActiveErrorsCount = 0;
                }
            }
        } catch (e) { }
    })();

    // 2. Error Reports Polling (Independent)
    (async () => {
        try {
            const sumRes = await fetch(`http://${host}/api/v2.0.0/log/error_reports`, { headers });
            if (sumRes.ok) {
                const logs = await sumRes.json();
                if (Array.isArray(logs)) {
                    if (logs.length === 0) {
                        lastFetchedErrorId = 0; // Safe fallback for empty array
                    } else if (lastFetchedErrorId === -1) {
                        lastFetchedErrorId = Math.max(...logs.map(l => l.id || 0));
                    } else {
                        const newLogs = logs.filter(log => (log.id || 0) > lastFetchedErrorId);
                        if (newLogs.length > 0) {
                            lastFetchedErrorId = Math.max(...newLogs.map(l => l.id || 0));
                            for (const log of newLogs) {
                                try {
                                    const detailRes = await fetch(`http://${host}/api/v2.0.0/log/error_reports/${log.id}`, { headers });
                                    if (detailRes.ok) {
                                        const detail = await detailRes.json();
                                        const module = detail.module || 'System';
                                        const message = detail.description || '상세 없음';
                                        const timeStr = detail.time ? new Date(detail.time).toLocaleTimeString('ko-KR', { hour12: false }) : new Date().toLocaleTimeString('ko-KR', { hour12: false });
                                        appendLogRow('mirLogTbody', 'ERROR', module, message, timeStr);
                                        logMirSystemData(`[새 에러] ${module}: ${message}`, "err");
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                }
            }
        } catch (e) { }
    })();

    // 3. Mission Queue Polling (Independent)
    (async () => {
        try {
            const missRes = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { headers });
            if (missRes.ok) {
                const missions = await missRes.json();
                if (Array.isArray(missions)) { // REMOVED length > 0 CHECK
                    const activeQueue = missions.filter(m => m.state === 'Pending' || m.state === 'Executing' || m.state === 'Starting');
                    const elState = document.getElementById('mirMissionQueueState');
                    if (elState) {
                        if (activeQueue.length === 0) {
                            elState.innerText = "—";
                            elState.style.color = "#666";
                            if (lastMissionQueueState !== 'None') {
                                logMirSystemData("모든 임무가 종료되었습니다.", "info");
                                lastMissionQueueState = 'None';
                            }
                        } else {
                            const m = activeQueue[0];
                            const st = m.state || "Pending";
                            elState.innerText = `${st} (ID: ${m.id})`;
                            elState.style.color = st === "Executing" ? "#4ade80" : "#ffcc00";
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
                    syncMissionQueueUI(activeQueue); // Now safely clears blur when activeQueue is empty
                }
            }
        } catch (e) { }
    })();

    // 4. System Logs Polling (Independent)
    (async () => {
        try {
            const sysLogRes = await fetch(`http://${host}/api/v2.0.0/log/sys_log`, { headers });
            if (sysLogRes.ok) {
                const logs = await sysLogRes.json();
                if (Array.isArray(logs) && logs.length > 0) {
                    if (lastFetchedSysLogId === -1) {
                        lastFetchedSysLogId = Math.max(...logs.map(l => l.id || 0));
                        // Render initial logs
                        const initialLogs = logs.slice(-15);
                        for (const log of initialLogs) {
                            let level = "INFO";
                            if (log.description && (log.description.includes("Error") || log.description.includes("Fail"))) level = "ERROR";
                            else if (log.description && (log.description.includes("Warning") || log.description.includes("Warn"))) level = "WARN";
                            const module = log.module || "System";
                            const timeStr = log.time ? new Date(log.time).toLocaleTimeString('ko-KR', { hour12: false }) : new Date().toLocaleTimeString('ko-KR', { hour12: false });
                            appendLogRow('mirLogTbody', level, module, log.description, timeStr);
                        }
                    } else {
                        const newLogs = logs.filter(log => (log.id || 0) > lastFetchedSysLogId);
                        if (newLogs.length > 0) {
                            lastFetchedSysLogId = Math.max(...newLogs.map(l => l.id || 0));
                            for (const log of newLogs) {
                                let level = "INFO";
                                if (log.description && (log.description.includes("Error") || log.description.includes("Fail"))) level = "ERROR";
                                else if (log.description && (log.description.includes("Warning") || log.description.includes("Warn"))) level = "WARN";
                                const module = log.module || "System";
                                const message = log.description || "Log entry";
                                const timeStr = log.time ? new Date(log.time).toLocaleTimeString('ko-KR', { hour12: false }) : new Date().toLocaleTimeString('ko-KR', { hour12: false });
                                appendLogRow('mirLogTbody', level, module, message, timeStr);
                                logMirSystemData(message, level === "ERROR" ? "err" : level === "WARN" ? "warn" : "info");
                            }
                        }
                    }
                }
            }
        } catch (e) { }
    })();
    updateWaypointHighlighting();
};

function syncMissionQueueUI(activeQueue) {
    const box = document.getElementById('mirMissionListSetup');
    if (!box) return;
    const activeMissionGuids = new Set(activeQueue.map(m => {
        const parts = String(m.mission_id).split('/');
        return parts[parts.length - 1];
    }));
    const rows = box.querySelectorAll('label.waypoint-item');
    rows.forEach(row => {
        const chk = row.querySelector('input[type="checkbox"]');
        if (!chk) return;
        const guid = chk.value;

        // CRITICAL CHECK: Look at BOTH the real queue and the optimistic local lock
        if (activeMissionGuids.has(guid) || (typeof optimisticMissions !== 'undefined' && optimisticMissions.has(guid))) {
            row.classList.add('in-queue-mission');
            chk.disabled = true;
            chk.checked = false;
        } else {
            row.classList.remove('in-queue-mission');
            chk.disabled = false;
        }
    });
}

function updateWaypointHighlighting() {
    if (!mirCtrl.map || !mirCtrl.map.waypoints) return;
    const tolerance = 0.5;
    let closestWp = null;
    let minDist = Infinity;
    mirCtrl.map.waypoints.forEach(wp => {
        const dx = globalRobotPosition.x - wp.pos_x;
        const dy = globalRobotPosition.y - wp.pos_y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < tolerance && dist < minDist) {
            minDist = dist;
            closestWp = wp;
        }
    });
    const posList = document.getElementById('mirPositionsList');
    if (posList) {
        const items = posList.querySelectorAll('.waypoint-item');
        items.forEach(item => {
            if (closestWp && item.dataset.guid === closestWp.guid) {
                item.classList.add('active-waypoint-highlight');
            } else {
                item.classList.remove('active-waypoint-highlight');
            }
        });
    }
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
            chk.style.cssText = 'margin-right:10px;accent-color:#00a5e5;';
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
    const elList = document.getElementById('mirPositionsList');
    if (!elList) return;
    const waypoints = mirCtrl.map.waypoints || [];
    const chargers = mirCtrl.map.chargers || [];
    elList.innerHTML = '';
    const allPos = [
        ...waypoints.map(w => ({ ...w, icon: '📍', label: 'Waypoint' })),
        ...chargers.map(c => ({ ...c, icon: '🔋', label: 'Charger' }))
    ];
    if (allPos.length === 0) {
        elList.innerHTML = '<div style="padding:10px; color:#666;">No positions found.</div>';
        return;
    }
    allPos.forEach(p => {
        const item = document.createElement('div');
        item.className = 'waypoint-item';
        item.dataset.guid = p.guid;
        item.innerHTML = `<span>${p.icon} ${p.name || 'Unnamed'}</span><span style="font-size:9px; color:#555;">${p.label}</span>`;
        // Removed onclick logic to make it Read-Only legend as per corrected requirement
        elList.appendChild(item);
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

function renderScenarioButtons() {
    config.ur.scenarios.forEach(sc => {
        const btn = document.createElement('button');
        btn.className = "scenario-btn";
        btn.innerText = sc.label;
        btn.onclick = () => {
            urCtrl.publishScenarioById(sc.id);
            logUr(`[SCENARIO] Calling ID ${sc.id} (${sc.label}) → ${config.ur.scenarioTopic}`);
        };
        elScenarioGrid.appendChild(btn);
    });
}

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

window.cmdMirPlayPause = async () => {
    const target = mirCtrl.state.id === 3 ? 4 : 3;
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: target }) });
    } catch (e) { }
};

window.cmdMirDock = () => {
    if (mirCtrl.missions.dockGuid) {
        const charger = (mirCtrl.map.chargers && mirCtrl.map.chargers.length > 0) ? mirCtrl.map.chargers[0].guid : null;
        mirCtrl.postMission(mirCtrl.missions.dockGuid, charger);
    }
};

window.cmdMirCancel = async () => {
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ clear_error: true }) });
        await new Promise(r => setTimeout(r, 100));
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 4 }) });
    } catch (e) { }
};

window.cmdMirClearErr = async () => {
    try {
        await fetch(`http://${getMirHost()}/api/v2.0.0/status`, { method: 'PUT', headers: getMirHeaders(), body: JSON.stringify({ clear_error: true }) });
    } catch (e) { }
};

window.cmdAddMissionToQueue = async () => {
    if (checkedSetupMissions.length === 0) return alert('추가할 미션을 체크해주세요.');

    // [CRITICAL FIX] 1. INSTANT UI FEEDBACK (Optimistic)
    const box = document.getElementById('mirMissionListSetup');
    if (box) {
        box.querySelectorAll('input[type="checkbox"]:checked').forEach(c => {
            c.disabled = true;
            c.parentElement.classList.add('in-queue-mission');
        });
    }

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
            optimisticMissions.add(guid); // Protect state
            const res = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { method: 'POST', headers, body: JSON.stringify({ mission_id: guid }) });
            if (res.ok) successCount++;
            else failCount++;
        }

        if (successCount > 0) logMirSystemData(`미션 ${successCount}개가 큐에 추가되었습니다.`, 'ok');
        if (failCount > 0) logMirSystemData(`미션 ${failCount}개 추가 실패 (로봇 상태 확인)`, 'err');

        checkedSetupMissions = [];

        // Let actual polling take over after 3 seconds
        setTimeout(() => { optimisticMissions.clear(); window.pollDetailedLogs(); }, 3000);
        window.pollDetailedLogs();

    } catch (e) {
        logMirSystemData(`미션 추가 중 오류: ${e.message}`, "err");
        optimisticMissions.clear();
        window.pollDetailedLogs(); // Revert UI if completely failed
    }
};

window.cmdClearMissionQueue = async () => {
    if (confirm("정말로 미션 큐를 모두 삭제하시겠습니까?")) {
        try {
            const res = await fetch(`http://${getMirHost()}/api/v2.0.0/mission_queue`, { method: 'DELETE', headers: getMirHeaders() });
            if (res.ok) logMirSystemData("미션 큐가 모두 삭제되었습니다.", "warn");
        } catch (e) { }
    }
};

window.cmdUrManualMode = () => {
    isUrManualMode = !isUrManualMode;
    const el = document.getElementById('topic-states-main');
    if (el) {
        el.textContent = isUrManualMode ? "MANUAL" : "AUTO";
        el.style.color = isUrManualMode ? "orange" : "#4ade80";
    }
    urCtrl.publishManualMode(isUrManualMode);
};

window.cmdUrUnlock = () => {
    isUrUnlock = !isUrUnlock;
    const el = document.getElementById('topic-unlock-setup');
    if (el) {
        el.textContent = isUrUnlock ? "UNLOCKED" : "LOCKED";
        el.style.color = isUrUnlock ? "#4ade80" : "#aaa";
    }
    urCtrl.publishUnlock(isUrUnlock);
};

window.cmdUrEstop = () => {
    isUrEstop = !isUrEstop;
    ['topic-estop-main', 'topic-estop-setup'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = isUrEstop ? "ENGAGED" : "OK";
            el.style.color = isUrEstop ? "#ff4d4d" : "#4ade80";
        }
    });
    urCtrl.publishEstop(isUrEstop);
};

window.cmdSetInitialPosition = () => {
    isUrInitial = !isUrInitial;
    const btns = document.querySelectorAll('button[onclick="cmdSetInitialPosition()"]');
    btns.forEach(btn => {
        btn.style.backgroundColor = isUrInitial ? "#4ade80" : "";
        btn.style.color = isUrInitial ? "#fff" : "";
        btn.style.borderColor = isUrInitial ? "#4ade80" : "";
    });
    urCtrl.publishInitialPose(isUrInitial);
};

window.cmdAdjustRobotPosition = async () => {
    const curPos = globalRobotPosition || { x: 0, y: 0, orientation: 0 };
    let defX = mirCtrl.targetX !== undefined ? mirCtrl.targetX : curPos.x;
    let defY = mirCtrl.targetY !== undefined ? mirCtrl.targetY : curPos.y;
    let defTheta = curPos.orientation;
    const result = await window.openCustomPrompt(defX, defY, defTheta);
    mirCtrl.targetX = undefined; mirCtrl.targetY = undefined;
    if (!result) return;
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 4, clear_error: true }) });
        await new Promise(r => setTimeout(r, 500));
        const resPos = await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ position: { x: Number(result.x), y: Number(result.y), orientation: Number(result.theta) } }) });
        if (resPos.ok) {
            await new Promise(r => setTimeout(r, 500));
            await fetch(`http://${host}/api/v2.0.0/status`, { method: 'PUT', headers, body: JSON.stringify({ state_id: 3 }) });
            logMirSystemData("위치 보정 완료.", "ok");
        }
    } catch (e) { }
};

window.cmdCaptureImage = () => {
    const img = document.getElementById('camera-stream');
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

        // Success Notification
        addNotification(`Success: Image captured to Pictures folder`, 'ok');
    } catch (e) { }
};

let globalTargetJoints = {};

/**
 * [GALAXY BRAIN] Refactored 3D Viewer - Single Canvas Re-parenting Strategy
 * This approach uses exactly ONE WebGL context and moves it between containers.
 */
function initROS3DViewer() {
    // 1. Bulletproof Joint Subscriber (Handles both Arrays [ROS] and Objects [Parsed])
    urCtrl.startJointSubscriber((msg) => {
        if (!msg) return;
        const newJoints = {};
        
        if (msg.name && msg.position) {
            // Format A: Raw ROS 2 Message Arrays
            for (let i = 0; i < msg.name.length; i++) {
                newJoints[msg.name[i]] = msg.position[i];
            }
        } else if (typeof msg === 'object') {
            // Format B: Pre-parsed Dictionary
            for (const key in msg) {
                newJoints[key] = msg[key];
            }
        }
        
        if (Object.keys(newJoints).length > 0) {
            globalTargetJoints = newJoints;
        }
    });

    // 2. Calibration Configuration
    const modelBaseConfig = {
        heading: 0,
        rosToWebGLRotation: -Math.PI / 2
    };

    const jointCalibration = {
        'shoulder_pan_joint': { multiplier: 1, offset: 0 },
        'shoulder_lift_joint': { multiplier: 1, offset: 0 },
        'elbow_joint':         { multiplier: 1, offset: 0 },
        'wrist_1_joint':       { multiplier: 1, offset: 0 },
        'wrist_2_joint':       { multiplier: 1, offset: 0 },
        'wrist_3_joint':       { multiplier: 1, offset: 0 }
    };

    // 3. Initialize Shared THREE.js Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#ebebeb');
    scene.add(new THREE.AxesHelper(1));
    scene.add(new THREE.GridHelper(10, 10, 0xcccccc, 0xdddddd));

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(1.5, 1.0, 1.5);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    window.shared3DViewer = { renderer, camera, scene, robot: null };

    // Initially attach to the currently active tab
    const isSetupActive = document.getElementById('tabSetup').classList.contains('active');
    const targetId = isSetupActive ? 'urdf-viewer-setup' : 'urdf-viewer';
    const initialContainer = document.getElementById(targetId);

    if (initialContainer) {
        initialContainer.appendChild(renderer.domElement);
        const w = initialContainer.clientWidth || 800;
        const h = initialContainer.clientHeight || 450;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.DirectionalLight(0xffffff, 1.0).add(new THREE.AmbientLight(0xffffff, 0.6)));

    const rosWrapper = new THREE.Group();
    rosWrapper.rotation.x = modelBaseConfig.rosToWebGLRotation;
    scene.add(rosWrapper);

    // 4. Load URDF (Once)
    const loader = new URDFLoader(new THREE.LoadingManager());
    loader.packages = { 'ur_description': `file://${__dirname}/src/Universal_Robots_ROS2_Description` };
    
    loader.load(`file://${__dirname}/src/ur5e.urdf`, robot => {
        rosWrapper.add(robot);
        window.shared3DViewer.robot = robot;
        robot.rotation.z = modelBaseConfig.heading;
        logUr(`[WebGL] Shared URDF model loaded.`);
        
        // Diagnostic: Log URDF joints to console
        console.log("--- URDF Model Joints ---", Object.keys(robot.joints));
    });

    // 5. Bulletproof Render Loop
    let hasLoggedMismatch = false;

    const renderLoop = function () {
        urdfReqId = requestAnimationFrame(renderLoop);
        const robot = window.shared3DViewer.robot;
        
        if (robot && Object.keys(globalTargetJoints).length > 0) {
            // One-time Diagnostic: Check name mismatch
            if (!hasLoggedMismatch) {
                console.log("--- ROS Joint Topic Keys ---", Object.keys(globalTargetJoints));
                hasLoggedMismatch = true;
            }

            for (const jName in globalTargetJoints) {
                const targetPosition = globalTargetJoints[jName];
                if (typeof targetPosition === 'number' && !isNaN(targetPosition)) {
                    const cal = jointCalibration[jName] || { multiplier: 1, offset: 0 };
                    const finalAngle = (targetPosition * cal.multiplier) + cal.offset;
                    
                    // Priority 1: Official setJointValue API
                    if (typeof robot.setJointValue === 'function') {
                        robot.setJointValue(jName, finalAngle);
                    } 
                    // Priority 2: Direct joint access
                    else if (robot.joints && robot.joints[jName]) {
                        robot.joints[jName].jointValue = finalAngle;
                    }
                }
            }
        }
        
        controls.update();

        // [AUTO-RESIZE] Check for parent container visibility and reported size
        const container = renderer.domElement.parentElement;
        if (container && container.clientWidth > 0 && container.clientHeight > 0) {
            const width = container.clientWidth;
            const height = container.clientHeight;
            
            // Trigger three.js resize only if size actually mismatch
            if (renderer.domElement.width !== width || renderer.domElement.height !== height) {
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
            }
            renderer.render(scene, camera);
        }
    };
    renderLoop();
}

window.cmdRefresh3DViewer = () => {
    if (urdfReqId) cancelAnimationFrame(urdfReqId);
    
    if (window.shared3DViewer && window.shared3DViewer.renderer) {
        window.shared3DViewer.renderer.dispose();
    }
    
    const c1 = document.getElementById('urdf-viewer');
    const c2 = document.getElementById('urdf-viewer-setup');
    if (c1) c1.innerHTML = '';
    if (c2) c2.innerHTML = '';
    
    initROS3DViewer();
    logUr("[INFO] 3D Viewer refreshed.");
    addNotification("Success: 3D Viewer context re-initialized", "ok");
};


function startUrStateSubscribers() {
    // Legacy subscriber removed in favor of logical status indicators
}

function startUrEstopMonitor() {
    const { spawn } = require('child_process');
    const proc = spawn('bash', ['-c', `source /opt/ros/humble/setup.bash && stdbuf -oL ros2 topic echo ${config.ur.estopTopic} std_msgs/msg/Bool`]);
    proc.stdout.on('data', (d) => {
        const match = d.toString().match(/data:\s*(true|false)/i);
        if (match) {
            const isEstopFromTopic = match[1].toLowerCase() === 'true';
            
            // [FIX] If the user has manually engaged the E-Stop (isUrEstop is true),
            // ignore the background node's "false" spam.
            if (isUrEstop && !isEstopFromTopic) return;

            const el = document.getElementById('topic-estop-main');
            if (el) {
                el.textContent = isEstopFromTopic ? 'ENGAGED' : 'OK';
                el.style.color = isEstopFromTopic ? '#ff4d4d' : '#4ade80';
            }
        }
    });
}

function wireMapCheckboxes() {
    const wire = (id, field, peerId) => {
        const el = document.getElementById(id);
        if (el) {
            el.onchange = (e) => {
                const checked = e.target.checked;
                mirCtrl[field] = checked;
                if (typeof mirCtrl.drawMap === 'function') mirCtrl.drawMap();

                // Sync with peer checkbox
                if (peerId) {
                    const peer = document.getElementById(peerId);
                    if (peer) peer.checked = checked;
                }
            };
        }
    };

    // Synchronized pairs
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
        cvs.onclick = (e) => {
            if (!mapImgObj) return;
            const rect = cvs.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (cvs.width / rect.width);
            const y = (e.clientY - rect.top) * (cvs.height / rect.height);
            const r = globalMapMeta.r || 0.05, ox = globalMapMeta.ox || 0, oy = globalMapMeta.oy || 0;
            mirCtrl.targetX = x * r + ox; mirCtrl.targetY = (cvs.height - y) * r + oy;
            window.cmdAdjustRobotPosition();
        };
    };
    interaction('mapCanvas'); interaction('setupMapCanvas');
}

window.onload = () => {
    mirCtrl.init(mapCanvas, null, (state, extra) => {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
        set('mirStateText', state.text || "—");
        set('mirBattery', `${(state.battery || 0).toFixed(1)}%`);

        // RESTORED UI BINDINGS
        set('mirRobotNameSetup', state.robot_name || "Unknown");
        set('mirSerialSetup', state.serial_number || "Unknown");

        const batMins = state.battery_time_remaining ? Math.floor(state.battery_time_remaining / 60) : 0;
        set('mirBatteryTime', batMins > 0 ? `${batMins} min` : "—");

        const upHrs = state.uptime ? Math.floor(state.uptime / 3600) : 0;
        const upMins = state.uptime ? Math.floor((state.uptime % 3600) / 60) : 0;
        set('mirUptime', state.uptime ? `${upHrs}h ${upMins}m` : "—");

        set('mirMoved', state.moved_distance ? `${state.moved_distance.toFixed(2)} m` : "—");
        set('mirErrorCount', state.errors ? state.errors.length : 0);

        // ALWAYS sync global position for the map overlay
        globalRobotPosition.x = state.x;
        globalRobotPosition.y = state.y;
        globalRobotPosition.orientation = state.theta;

        if (extra && extra.positionsLoaded) { updateWaypointCheckboxes(); updateMirPositionsList(); }
    }, document.getElementById('setupMapCanvas'));

    // [HEARTBEAT & LOG FIX] High-timeout for sporadically publishing logs
    urCtrl.startLogSubscriber((msg) => {
        if (urCtrl.lastHeartbeat) urCtrl.lastHeartbeat.log = new Date(); // Fixes "Waiting" in Setup tab
        const text = msg.msg || (typeof msg === 'string' ? msg : JSON.stringify(msg));
        const level = (text.toLowerCase().includes("error") || msg.level >= 40) ? "ERROR" : "INFO";
        const nodeName = msg.name || 'UR_Node';
        appendLogRow('urLogTbody', level, nodeName, text);

        // Update Main Dashboard Error Indicator
        updateDashboardErrorState(level === "ERROR");
    });

    urCtrl.startRosoutSubscriber((msg) => {
        if (urCtrl.lastHeartbeat) urCtrl.lastHeartbeat.rosout = new Date();
        const level = msg.toLowerCase().includes("error") ? "ERROR" : "INFO";
        appendLogRow('rosoutTbody', level, 'ros', msg);
    });

    const imgStream = document.getElementById('camera-stream');
    urCtrl.startCameraSubscriber((b64) => {
        if (imgStream) {
            imgStream.src = "data:image/jpeg;base64," + b64;
            // [FORCED VISIBILITY] Ensure image tag is shown once data arrives
            imgStream.style.display = 'block';
        }
    });

    startUrStateSubscribers();
    startUrEstopMonitor();
    wireMapCheckboxes();
    setInterval(pollTopicHeartbeats, 2000);
    setTimeout(() => { window.fetchAndRenderUserMissions(); }, 1500);
    setInterval(() => { window.pollDetailedLogs(); }, 1000);
    setInterval(() => { fetchDiagnosticsAPI(); }, 3000);
    setInterval(() => { fetchProtectiveScanAPI(); }, 500);
    renderScenarioButtons();
    initROS3DViewer();
    updateMapScaleBar();
    logUr("[INFO] ROS2 pipeline initialized.");
};