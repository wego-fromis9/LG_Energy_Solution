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

// Map & Localization globals
let globalRobotPosition = { x: 0, y: 0, orientation: 0 };
let globalMapMeta = { r: 0.05, ox: 0, oy: 0, w: 800, h: 800 };
let currentMapId = null;
let mapImgObj = null;

// UR State tracking (received from ROS2 topics)
let urState = { states: '—', error: '—', estop: false };

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
    // Log into both the Setup and Main mini-log panels
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
    if (tbodyId === 'mirLogTbody') {
        const s = state.toUpperCase();
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
    const s = state.toUpperCase();
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
    const alive = (ts) => ts && (now - ts) < 5000;

    updateTopicStatus('topic-log-setup', alive(hb.log), config.ur.logTopic);
    updateTopicStatus('topic-unlock-setup', true, config.ur.unlockTopic);
    updateTopicStatus('topic-estop-setup', true, config.ur.estopTopic);
    updateTopicStatus('topic-joint-setup', alive(hb.joint), config.ur.jointTopic);
    updateTopicStatus('topic-rosout-setup', alive(hb.rosout), config.ur.rosoutTopic);
    updateTopicStatus('topic-camera-setup', alive(hb.camera), config.ur.cameraTopic);
}

// -----------------------------------------------
// LiDAR Scan & Robot Position Visualizer
// -----------------------------------------------

// [NEW] 유저 커스텀 화살표 이미지 로드
const customArrowImg = new Image();
// 💡 주의: 사용하실 이미지의 정확한 경로와 파일명으로 수정해 주세요! (예: 'images/image_74a9bc.png')
customArrowImg.src = 'images/nav_arrow.png';

async function fetchProtectiveScanAPI() {
    if (!currentMapId || !mapImgObj) return;

    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        // MiR 공식 API: 로봇 주변의 스캔 데이터를 이미지로 반환
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
                // 이미지가 손상되었더라도 로봇 중심 위치는 강제 렌더링
                drawProtectiveScanOverlay(null);
            };
            img.src = imgUrl;
        } else {
            // API 실패 시에도 로봇 중심 위치는 강제 렌더링
            drawProtectiveScanOverlay(null);
        }
    } catch (e) {
        drawProtectiveScanOverlay(null);
    }
}

function drawProtectiveScanOverlay(img) {
    if (!mapImgObj) return;

    ['lidarCanvas', 'lidarCanvasSetup'].forEach(id => {
        const cvs = document.getElementById(id);
        if (cvs && mapImgObj) {
            // 맵 캔버스와 동일한 논리적 해상도를 설정
            if (cvs.width !== mapImgObj.width || cvs.height !== mapImgObj.height) {
                cvs.width = mapImgObj.width;
                cvs.height = mapImgObj.height;
            }

            const ctx = cvs.getContext('2d');
            ctx.clearRect(0, 0, cvs.width, cvs.height);

            const r = globalMapMeta.r || 0.05;
            const ox = globalMapMeta.ox || 0;
            const oy = globalMapMeta.oy || 0;

            // 로봇의 현재 맵 상 픽셀 좌표 계산 (Y축 반전 고려)
            const rx = (globalRobotPosition.x - ox) / r;
            const ry = mapImgObj.height - ((globalRobotPosition.y - oy) / r);

            // 로봇의 회전 각도 (라디안)
            const rad = globalRobotPosition.orientation * (Math.PI / 180);

            ctx.save();
            // 캔버스의 원점을 로봇의 현재 픽셀 좌표로 이동
            ctx.translate(rx, ry);
            // 로봇이 바라보는 방향에 맞게 캔버스 회전 (-rad 적용: HTML Canvas Y축 반전 때문)
            ctx.rotate(-rad);

            // 1. 라이다 이미지가 수신되었으면 로봇 중심으로 렌더링
            if (img) {
                const scanRes = 0.05;
                const mapRes = globalMapMeta.r || 0.05;
                const scale = scanRes / mapRes;

                // 이미지의 중심이 로봇의 현재 픽셀 위치(rx, ry)에 오도록 그림
                ctx.drawImage(img, (-img.width / 2) * scale, (-img.height / 2) * scale, img.width * scale, img.height * scale);
            }

            // 2. 로봇의 실시간 위치와 헤딩(방향)을 직접 만든 이미지로 표출
            if (customArrowImg.complete && customArrowImg.naturalHeight !== 0) {
                // 커스텀 이미지 크기 설정 (원하는 크기로 조절하세요. 40x40 픽셀)
                const iconSize = 40;

                ctx.save();
                // 💡 핵심: 첨부하신 이미지는 위쪽(↑)을 가리킵니다.
                // 캔버스의 기본 전방은 오른쪽(→) 이므로 이미지를 시계방향으로 90도 회전시켜서 방향을 맞춰줍니다.
                ctx.rotate(Math.PI / 2);

                // 중심을 맞추기 위해 x, y를 각각 너비/높이의 절반만큼 빼서 그립니다.
                ctx.drawImage(customArrowImg, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
                ctx.restore();
            } else {
                // 커스텀 이미지를 불러오는 중이거나 실패했을 때 보여줄 기본 폴백(파란 원)
                ctx.fillStyle = '#4285F4';
                ctx.beginPath();
                ctx.arc(0, 0, 12, 0, 2 * Math.PI);
                ctx.fill();
            }

            ctx.restore();
        }
    });
}

window.toggleLidar = (which, visible) => {
    const ids = which === 'setup' ? ['lidarCanvasSetup'] : ['lidarCanvas'];
    ids.forEach(id => {
        const c = document.getElementById(id);
        if (c) c.style.display = visible ? 'block' : 'none';
    });
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

        const posRes = await fetch(`http://${host}/api/v2.0.0/maps/${currentMapId}/positions`, { headers });
        if (!posRes.ok) throw new Error(`Positions ${posRes.status}`);
        const positions = await posRes.json();

        const mapDataRes = await fetch(`http://${host}/api/v2.0.0/maps/${currentMapId}`, { headers });
        if (!mapDataRes.ok) throw new Error(`Map Data ${mapDataRes.status}`);
        const mapData = await mapDataRes.json();

        if (!mirCtrl.map) mirCtrl.map = {};
        mirCtrl.map.currentId = currentMapId;
        mirCtrl.map.waypoints = positions.filter(p => p.type_id === 0 || p.type_id === 11);
        mirCtrl.map.chargers = positions.filter(p => p.type_id === 7 || p.type_id === 8);

        globalMapMeta.r = mapData.resolution || 0.05;
        globalMapMeta.ox = mapData.origin_x || 0;
        globalMapMeta.oy = mapData.origin_y || 0;

        if (mapData.base_map) {
            const img = new Image();
            img.src = "data:image/png;base64," + mapData.base_map;
            img.onload = () => {
                mapImgObj = img;
                globalMapMeta.w = img.width;
                globalMapMeta.h = img.height;

                ['mapCanvas', 'setupMapCanvas'].forEach(id => {
                    const cvs = document.getElementById(id);
                    if (cvs) {
                        cvs.width = img.width;
                        cvs.height = img.height;
                        const ctx = cvs.getContext('2d');
                        ctx.clearRect(0, 0, cvs.width, cvs.height);
                        ctx.drawImage(img, 0, 0);
                    }
                });

                logMirSystemData(`맵 렌더링 완료 (${positions.length}개 위치)`, "ok");
            };
        }

        updateWaypointCheckboxes();
        updateMirPositionsList();

    } catch (e) {
        logMirSystemData(`맵 갱신 실패: ${e.message}`, "err");
    }
};

// -----------------------------------------------
// MiR Status Polling (main loop) - 실시간 전용
// -----------------------------------------------
let lastFetchedErrorId = -1;
let lastFetchedMissionId = -1;
let lastFetchedSysLogId = -1; // 추가: 시스템 전체 로그 트래킹용 ID
let lastActiveErrorsCount = 0;
let lastMissionQueueState = '';

window.pollDetailedLogs = async () => {
    const host = getMirHost();
    const headers = getMirHeaders();

    // 1. Status Polling (Global State, Missions Text & Active Errors)
    try {
        const statRes = await fetch(`http://${host}/api/v2.0.0/status`, { headers });
        if (statRes.ok) {
            const stat = await statRes.json();

            if (stat.position) globalRobotPosition = stat.position;

            if (stat.map_id && stat.map_id !== currentMapId) {
                currentMapId = stat.map_id;
                window.cmdRefreshSetupMap();
            }

            // 상태 메시지나 미션 텍스트가 변경되었을 때 실시간 로깅
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

    // 2. Error Reports Polling (과거 로그 무시, 실시간 발생 로그만 기록)
    try {
        const sumRes = await fetch(`http://${host}/api/v2.0.0/log/error_reports`, { headers });
        if (sumRes.ok) {
            const logs = await sumRes.json();
            if (Array.isArray(logs) && logs.length > 0) {
                if (lastFetchedErrorId === -1) {
                    // 맨 처음 실행 시, 과거 에러는 모두 무시하고 현재 최고 ID만 기억
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

    // 3. Mission Queue Polling (과거 로그 무시, 실시간 실행 미션만 기록)
    try {
        const missRes = await fetch(`http://${host}/api/v2.0.0/mission_queue`, { headers });
        if (missRes.ok) {
            const missions = await missRes.json();
            if (Array.isArray(missions) && missions.length > 0) {

                // Dashboard UI용 미션 큐 상태 업데이트
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

                // 새로운 미션(완료, 취소 등) 실시간 로깅
                if (lastFetchedMissionId === -1) {
                    // 맨 처음 실행 시, 과거 미션은 무시
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
                                    const source = (detail.mission_id || 'Unknown').substring(0, 20);
                                    const message = (detail.message || 'No message').substring(0, 40);
                                    const timeStr = detail.finished || detail.started || new Date().toLocaleTimeString('ko-KR', { hour12: false });
                                    appendLogRow('mirLogTbody', `MISSION ${state}`, source, message, timeStr);
                                }
                            } catch (e) { }
                        }
                    }
                }

                // UI 동기화 호출
                syncMissionQueueUI(activeQueue);
            }
        }
    } catch (e) { }

    // 4. System Log Polling (All Levels - 실시간 발생 로그 전체 기록)
    try {
        const sysLogRes = await fetch(`http://${host}/api/v2.0.0/log/sys_log`, { headers });
        if (sysLogRes.ok) {
            const logs = await sysLogRes.json();
            if (Array.isArray(logs) && logs.length > 0) {
                if (lastFetchedSysLogId === -1) {
                    lastFetchedSysLogId = Math.max(...logs.map(l => l.id || 0));
                } else {
                    const newLogs = logs.filter(log => (log.id || 0) > lastFetchedSysLogId);
                    if (newLogs.length > 0) {
                        lastFetchedSysLogId = Math.max(...newLogs.map(l => l.id || 0));
                        for (const log of newLogs) {
                            // 로그 레벨에 따른 스타일 분류
                            let level = "INFO";
                            if (log.description && (log.description.includes("Error") || log.description.includes("Fail"))) level = "ERROR";
                            else if (log.description && (log.description.includes("Warning") || log.description.includes("Warn"))) level = "WARN";

                            const module = log.module || "System";
                            const message = log.description || "Log entry";
                            const timeStr = log.time ? new Date(log.time).toLocaleTimeString('ko-KR', { hour12: false }) : new Date().toLocaleTimeString('ko-KR', { hour12: false });

                            appendLogRow('mirLogTbody', level, module, message, timeStr);
                            // 미니 로그에도 업데이트
                            logMirSystemData(message, level === "ERROR" ? "err" : level === "WARN" ? "warn" : "info");
                        }
                    }
                }
            }
        }
    } catch (e) { }

    // 위치 기반 웨이포인트 하이라이팅 업데이트
    updateWaypointHighlighting();
};

function syncMissionQueueUI(activeQueue) {
    const box = document.getElementById('mirMissionListSetup');
    if (!box) return;

    const activeMissionGuids = new Set(activeQueue.map(m => {
        // mission_id가 URL 형태(/api/v2.0.0/missions/...)일 경우 GUID만 추출
        const parts = String(m.mission_id).split('/');
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
            chk.checked = false; // 실행 중인 미션은 체크 해제 처리
        } else {
            row.classList.remove('in-queue-mission');
            chk.disabled = false;
        }
    });
}

function updateWaypointHighlighting() {
    if (!mirCtrl.map || !mirCtrl.map.waypoints) return;

    const tolerance = 0.5; // 0.5 meters
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

    // Dashboard UI (mirPositionsList) 하이라이팅
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

// -----------------------------------------------
// Mission List (Setup Tab)
// -----------------------------------------------
window.fetchAndRenderUserMissions = async () => {
    const box = document.getElementById('mirMissionListSetup');
    if (!box) return;

    try {
        const url = `http://${getMirHost()}/api/v2.0.0/missions`;
        const res = await fetch(url, { headers: getMirHeaders() });
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const missions = await res.json();

        // [필터링 요구사항 적용]: mirconst-로 시작하는 미션 및 이름에 UR이 들어간 미션 숨김
        const userMissions = missions.filter(m => {
            const guid = m.guid || '';
            const name = (m.name || '').toUpperCase();

            const isSystemMission = guid.startsWith('mirconst-');
            const isURMission = name.includes('UR');

            return !isSystemMission && !isURMission;
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

        // 초기 로드 시에도 현재 큐 상태와 동기화
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

// -----------------------------------------------
// Positions List (Main Tab - left column)
// -----------------------------------------------
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
        item.dataset.guid = p.guid; // 하이라이팅을 위해 GUID 저장
        item.innerHTML = `
            <span>${p.icon} ${p.name || 'Unnamed'}</span>
            <span style="font-size:9px; color:#555;">${p.label}</span>
        `;
        // Clicking a waypoint ONLY highlights it in the list/UI and pre-checks in Setup tab
        // NO move command is triggered here.
        item.onclick = () => {
            // Remove previous active user-selection
            document.querySelectorAll('#mirPositionsList .waypoint-item').forEach(el => el.classList.remove('active-item'));
            item.classList.add('active-item');

            // Scroll to the matching waypoint in the Setup panel if open
            const checkboxes = document.querySelectorAll('#waypointCheckboxList input[type="checkbox"]');
            checkboxes.forEach(chk => {
                if (chk.value === p.guid) {
                    chk.checked = true;
                    handleCheckboxChange(chk, p.guid);
                    // 브라우저 뷰포트 내로 스크롤
                    chk.parentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        };
        elList.appendChild(item);
    });
}

// -----------------------------------------------
// Waypoint Checkbox Management
// -----------------------------------------------
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

// -----------------------------------------------
// Scenario Buttons
// -----------------------------------------------
function renderScenarioButtons() {
    config.ur.scenarios.forEach(sc => {
        const btn = document.createElement('button');
        btn.className = "scenario-btn";
        btn.innerText = sc.label;
        // Each scenario button publishes its ROS2 topic (Bool trigger)
        btn.onclick = () => {
            urCtrl.publishScenario(sc.topic);
            logUr(`[INFO] Scenario triggered: ${sc.label} → ${sc.topic}`);
        };
        elScenarioGrid.appendChild(btn);
    });
}

// -----------------------------------------------
// MiR Commands (REST API)
// -----------------------------------------------
window.cmdRunCheckedWaypoints = async () => {
    if (checkedSequence.length === 0) return logMirSystemData("실행 실패: 선택된 웨이포인트가 없습니다.", "err");
    logMirSystemData(`웨이포인트 시퀀스 실행 요청 (${checkedSequence.length}개)`, "info");
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
        logMirSystemData("반복 주행(Patrol) 시작됨.", "ok");
    } else {
        if (btn) { btn.innerText = "Patrol"; btn.style.borderColor = ""; }
        logMirSystemData("반복 주행(Patrol) 중지됨.", "warn");
    }
};

window.cmdMirPlayPause = async () => {
    const target = mirCtrl.state.id === 3 ? 4 : 3;
    logMirSystemData(`Play/Pause 요청 (Target ID: ${target})`, "info");
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT', headers, body: JSON.stringify({ state_id: target })
        });
    } catch (e) { }
};

window.cmdMirDock = () => {
    if (mirCtrl.missions.dockGuid) {
        logMirSystemData("복귀(Docking) 미션 호출됨", "info");
        const charger = (mirCtrl.map.chargers && mirCtrl.map.chargers.length > 0) ? mirCtrl.map.chargers[0].guid : null;
        mirCtrl.postMission(mirCtrl.missions.dockGuid, charger);
    } else {
        logMirSystemData("Dock 미션 GUID를 찾을 수 없습니다.", "warn");
    }
};

window.cmdMirCancel = async () => {
    logMirSystemData("미션 취소(로봇 정지) 요청됨", "warn");
    try {
        const host = getMirHost();
        const headers = getMirHeaders();
        // Clear error first
        await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT', headers, body: JSON.stringify({ clear_error: true })
        });
        await new Promise(r => setTimeout(r, 100));
        // Then set state to Pause
        await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT', headers, body: JSON.stringify({ state_id: 4 })
        });
    } catch (e) { }
};

window.cmdMirClearErr = async () => {
    logMirSystemData("에러 클리어 요청됨", "info");
    try {
        await fetch(`http://${getMirHost()}/api/v2.0.0/status`, {
            method: 'PUT', headers: getMirHeaders(), body: JSON.stringify({ clear_error: true })
        });
    } catch (e) { }
};

window.cmdAddMissionToQueue = async () => {
    if (checkedSetupMissions.length === 0) return alert('추가할 미션을 체크해주세요.');
    try {
        const host = getMirHost();
        const headers = getMirHeaders();

        const statRes = await fetch(`http://${host}/api/v2.0.0/status`, { headers });
        if (statRes.ok) {
            const stat = await statRes.json();
            if (stat.state_id !== 3 && stat.state_id !== 4) {
                logMirSystemData('로봇을 Ready 상태로 전환합니다...', 'info');
                await fetch(`http://${host}/api/v2.0.0/status`, {
                    method: 'PUT', headers, body: JSON.stringify({ state_id: 3 })
                });
                await new Promise(r => setTimeout(r, 800));
            }
        }

        let successCount = 0;
        for (const guid of checkedSetupMissions) {
            const res = await fetch(`http://${host}/api/v2.0.0/mission_queue`, {
                method: 'POST', headers, body: JSON.stringify({ mission_id: guid })
            });
            if (res.ok) {
                successCount++;
            } else {
                const errText = await res.text();
                logMirSystemData(`미션 큐 추가 실패 (HTTP ${res.status}): ${errText}`, 'err');
            }
        }

        if (successCount > 0) {
            logMirSystemData(`미션 ${successCount}개가 큐에 추가되었습니다.`, 'ok');
            const box = document.getElementById('mirMissionListSetup');
            if (box) box.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
            checkedSetupMissions = [];
        }
    } catch (e) {
        logMirSystemData(`미션 큐 추가 중 오류: ${e.message}`, 'err');
    }
};

window.cmdClearMissionQueue = async () => {
    if (confirm("정말로 미션 큐를 모두 삭제하시겠습니까?")) {
        try {
            const res = await fetch(`http://${getMirHost()}/api/v2.0.0/mission_queue`, {
                method: 'DELETE', headers: getMirHeaders()
            });
            if (res.ok) {
                logMirSystemData("미션 큐가 모두 삭제(Abort) 되었습니다.", "warn");
            } else {
                throw new Error(res.status);
            }
        } catch (e) {
            logMirSystemData(`미션 큐 삭제 실패: HTTP ${e.message}`, "err");
        }
    }
};

// -----------------------------------------------
// UR Commands (ROS2 Topic Publishers)
// -----------------------------------------------
// "Manual Mode" button in main dashboard — publish ROS2 topic
window.cmdUrManualMode = () => {
    urCtrl.publishManualMode();
    logUr(`[INFO] Published Manual Mode → ${config.ur.manualModeTopic}`);
};

// "Unlock" button in setup tab — publish ROS2 topic
window.cmdUrUnlock = () => {
    urCtrl.publishUnlock();
    logUr(`[INFO] Published Unlock → ${config.ur.unlockTopic}`);
};

// "E-Stop" button in main dashboard — publish ROS2 topic
window.cmdUrEstop = () => {
    urCtrl.publishEstop();
    logUr(`[INFO] Published E-Stop → ${config.ur.estopTopic}`);
};

// "Initial" button in setup tab — move UR to initial/home position via ROS2
window.cmdSetInitialPosition = () => {
    urCtrl.publishBoolTrigger(config.ur.initialPoseTopic || '/ur_initial_pose');
    logUr(`[INFO] Published Initial Pose → ${config.ur.initialPoseTopic || '/ur_initial_pose'}`);
};

// -----------------------------------------------
// MiR Adjust Robot Position (Localization)
// -----------------------------------------------
window.cmdAdjustRobotPosition = async () => {
    logMirSystemData("========== [위치 보정 시작] ==========", "info");

    const curPos = globalRobotPosition || { x: 0, y: 0, orientation: 0 };

    // 맵에서 클릭한 좌표가 있으면 해당 좌표를, 없으면 현재 로봇 좌표를 디폴트로 사용
    let defX = mirCtrl.targetX !== undefined ? mirCtrl.targetX : curPos.x;
    let defY = mirCtrl.targetY !== undefined ? mirCtrl.targetY : curPos.y;
    let defTheta = curPos.orientation;

    logMirSystemData("좌표 및 회전각 입력창을 엽니다...", "warn");

    // 사용자가 항상 X, Y, Theta를 정확히 입력/수정할 수 있도록 무조건 Prompt 호출
    const result = await window.openCustomPrompt(defX, defY, defTheta);

    // 입력창이 닫히면 타겟 초기화 (다음에 클릭 안하고 누르면 현재위치로 뜨게)
    mirCtrl.targetX = undefined;
    mirCtrl.targetY = undefined;

    if (!result) {
        logMirSystemData("위치 보정 작업이 취소되었습니다.", "warn");
        return;
    }

    const host = getMirHost();
    const headers = getMirHeaders();

    try {
        // [1] 로봇을 Pause(4) 상태로 설정하고 에러를 클리어 (위치 보정 필수 전제 조건)
        logMirSystemData(`로봇을 Pause 상태로 전환 및 에러 초기화...`, "info");
        await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT', headers, body: JSON.stringify({ state_id: 4, clear_error: true })
        });

        await new Promise(r => setTimeout(r, 500));

        // [2] 초기 좌표 덮어쓰기 (position 전송)
        logMirSystemData(`[1/2] 요청 좌표값: (${result.x.toFixed(2)}, ${result.y.toFixed(2)}, ${result.theta.toFixed(2)}°) 전송 중...`, "warn");

        const resPos = await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
                position: {
                    x: Number(result.x),
                    y: Number(result.y),
                    orientation: Number(result.theta)
                }
            })
        });

        if (!resPos.ok) {
            logMirSystemData(`[에러] 위치 업데이트 실패: ${resPos.status}`, "err");
            return; // 실패하면 여기서 종료
        }

        await new Promise(r => setTimeout(r, 500));

        // [3] 보정 완료 후 Ready(3) 상태로 진입
        logMirSystemData("[2/2] 위치 등록 완료. Ready(3) 상태로 전환합니다...", "info");
        const resReady = await fetch(`http://${host}/api/v2.0.0/status`, {
            method: 'PUT', headers, body: JSON.stringify({ state_id: 3 })
        });

        if (resReady.ok) {
            logMirSystemData("위치 보정 완료. 로봇이 스캔을 통해 위치를 보완합니다.", "ok");
        } else {
            logMirSystemData(`[에러] Ready 상태 전환 실패: ${resReady.status}`, "err");
        }
    } catch (e) {
        logMirSystemData(`[통신 오류] 위치 보정 중 예외 발생: ${e.message}`, "err");
    }
};

// -----------------------------------------------
// Camera Capture
// -----------------------------------------------
window.cmdCaptureImage = () => {
    const img = document.getElementById('camera-stream');
    if (!img || !img.src || !img.src.includes('base64')) {
        return logUr("[WARN] No image data available to capture.");
    }
    try {
        const base64Data = img.src.replace(/^data:image\/jpeg;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `capture_${timestamp}.jpg`;
        const savePath = path.join(os.homedir(), 'Pictures', filename);
        const dir = path.join(os.homedir(), 'Pictures');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(savePath, buffer);
        logUr(`[OK] 이미지 저장 완료: ${savePath}`);

        const feed = document.getElementById('camera-feed');
        if (feed) { feed.style.opacity = "0.5"; setTimeout(() => feed.style.opacity = "1", 100); }
    } catch (e) {
        logUr(`[ERROR] 이미지 저장 실패: ${e.message}`);
    }
};

// -----------------------------------------------
// URDF / WebGL 3D Viewer
// -----------------------------------------------
let globalTargetJoints = {};

function initROS3DViewer() {
    urCtrl.startJointSubscriber((joints) => {
        globalTargetJoints = joints;
    });

    const setupView = (divId) => {
        const viewerDiv = document.getElementById(divId);
        if (!viewerDiv) return;

        setTimeout(() => {
            try {
                const width = viewerDiv.clientWidth || 300;
                const height = viewerDiv.clientHeight || (divId.includes('setup') ? 200 : 300);

                const scene = new THREE.Scene();
                scene.background = new THREE.Color('#ebebeb');

                const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
                camera.position.set(2, 1.5, 2);
                camera.lookAt(0, 0, 0);

                const renderer = new THREE.WebGLRenderer({ antialias: true });
                renderer.setSize(width, height);
                renderer.shadowMap.enabled = true;
                viewerDiv.appendChild(renderer.domElement);

                const controls = new THREE.OrbitControls(camera, renderer.domElement);
                controls.enableDamping = true;
                controls.dampingFactor = 0.05;

                const grid = new THREE.GridHelper(5, 50, 0xcccccc, 0xdddddd);
                scene.add(grid);

                const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
                dirLight.position.set(10, 10, 10);
                scene.add(dirLight);
                scene.add(new THREE.AmbientLight(0xffffff, 0.6));

                const manager = new THREE.LoadingManager();
                const loader = new URDFLoader(manager);
                loader.packages = {
                    'ur_description': `file://${__dirname}/src/Universal_Robots_ROS2_Description`
                };

                let robotObj = null;

                loader.load(`file://${__dirname}/src/ur5e.urdf`, robot => {
                    robot.rotation.x = -Math.PI / 2;
                    scene.add(robot);
                    robotObj = robot;
                    logUr(`[WebGL] URDF 로드 완료 (${divId}).`);
                });

                const renderLoop = function () {
                    requestAnimationFrame(renderLoop);
                    if (robotObj) {
                        for (const jName in globalTargetJoints) {
                            let joint = robotObj.joints[jName];

                            // Try to map joint if exact name not found in URDF
                            if (!joint) {
                                const foundKey = Object.keys(robotObj.joints).find(k => k.includes(jName) || jName.includes(k));
                                if (foundKey) joint = robotObj.joints[foundKey];
                            }

                            const target = globalTargetJoints[jName];
                            if (joint && typeof target === 'number' && !isNaN(target)) {
                                const current = joint.angle || 0;
                                joint.setAngle(current + (target - current) * 0.15);
                            }
                        }
                    }
                    controls.update();
                    renderer.render(scene, camera);
                };
                renderLoop();

                const resizeObserver = new ResizeObserver(entries => {
                    for (let entry of entries) {
                        const w = entry.contentRect.width;
                        const h = entry.contentRect.height;
                        renderer.setSize(w, h);
                        camera.aspect = w / h;
                        camera.updateProjectionMatrix();
                    }
                });
                resizeObserver.observe(viewerDiv);

            } catch (e) {
                logUr(`[WebGL Error] ${e}`);
            }
        }, 500);
    };

    setupView('urdf-viewer');
    setupView('urdf-viewer-setup');
}

// -----------------------------------------------
// UR State Subscriber (ROS2 Topics → Main Dashboard)
// -----------------------------------------------
function startUrStateSubscribers() {
    // Subscribe to UR state topic (StringMultiArray or similar) — update main dashboard
    // We listen to /ur_log_broadcast for state text updates, but also wire up specific
    // subscribers for the states/error/estop cells in the main dashboard UR panel.

    // Poll‑style updates from heartbeat & direct topic data are handled by startLogSubscriber.
    // Here we add a dedicated subscriber for UR robot states.
    const urStateTopics = [
        { topic: config.ur.logTopic, elId: 'topic-states-main', label: 'states' },
    ];

    // Update UR state cells whenever we get log data
    const origLogCb = urCtrl.onLogCallback;
    urCtrl.setLogCallback((msg) => {
        if (origLogCb) origLogCb(msg);

        // Parse state from log messages
        if (msg.includes('[UR log]')) {
            const text = msg.replace('[UR log]', '').trim();

            const stateEl = document.getElementById('topic-states-main');
            if (stateEl) {
                stateEl.textContent = text.substring(0, 30);
                stateEl.style.color = '#4ade80';
            }
        }
        if (msg.includes('[ERROR]')) {
            const errorEl = document.getElementById('topic-error-main');
            if (errorEl) {
                errorEl.textContent = 'ERROR';
                errorEl.style.color = '#e57373';
            }
        }
    });
}

// UR E-Stop state — subscribe to estop topic echo
function startUrEstopMonitor() {
    const { spawn } = require('child_process');
    const cmd = `source /opt/ros/humble/setup.bash && stdbuf -oL ros2 topic echo ${config.ur.estopTopic} std_msgs/msg/Bool`;
    const proc = spawn('bash', ['-c', cmd]);
    proc.stdout.on('data', (d) => {
        const text = d.toString();
        const match = text.match(/data:\s*(true|false)/i);
        if (match) {
            const isEstop = match[1].toLowerCase() === 'true';
            const el = document.getElementById('topic-estop-main');
            if (el) {
                el.textContent = isEstop ? 'ACTIVE' : 'OK';
                el.style.color = isEstop ? '#e57373' : '#4ade80';
            }
        }
    });
    proc.on('close', () => { /* auto-restart handled by the controller */ });
}

// -----------------------------------------------
// Map Overlay Checkboxes (Main Tab)
// -----------------------------------------------
function wireMapCheckboxes() {
    const chkWaypoint = document.getElementById('chkWaypoint');
    const chkCharge = document.getElementById('chkCharge');
    const chkGrid = document.getElementById('chkGrid');
    const chkGridSetup = document.getElementById('chkGridSetup');

    if (chkWaypoint) {
        chkWaypoint.onchange = (e) => {
            mirCtrl.showWaypoints = e.target.checked;
            if (mirCtrl.map.baseImage) mirCtrl.drawMap();
        };
    }
    if (chkCharge) {
        chkCharge.onchange = (e) => {
            mirCtrl.showChargers = e.target.checked;
            if (mirCtrl.map.baseImage) mirCtrl.drawMap();
        };
    }
    if (chkGrid) {
        chkGrid.onchange = (e) => {
            if (chkGridSetup) chkGridSetup.checked = e.target.checked;
            mirCtrl.showGrid = e.target.checked;
            if (mirCtrl.map.baseImage) mirCtrl.drawMap();
        };
    }
    if (chkGridSetup) {
        chkGridSetup.onchange = (e) => {
            if (chkGrid) chkGrid.checked = e.target.checked;
            mirCtrl.showGrid = e.target.checked;
            if (mirCtrl.map.baseImage) mirCtrl.drawMap();
        };
    }

    // Add Map Interaction for Position Adjustment
    const mapInteraction = (cvs) => {
        if (!cvs) {
            console.error("[Map Click] cvs element is null");
            return;
        }
        cvs.style.cursor = 'crosshair';
        cvs.onclick = (e) => {
            if (!mapImgObj) {
                console.warn("[Map Click] mapImgObj is null. Cannot calculate coordinates.");
                return;
            }
            const rect = cvs.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (cvs.width / rect.width);
            const y = (e.clientY - rect.top) * (cvs.height / rect.height);

            const r = globalMapMeta.r || 0.05;
            const ox = globalMapMeta.ox || 0;
            const oy = globalMapMeta.oy || 0;

            const mapX = x * r + ox;
            const mapY = (cvs.height - y) * r + oy;

            mirCtrl.targetX = mapX;
            mirCtrl.targetY = mapY;

            // 사용자가 클릭했으므로 항상 프롬프트를 띄워서 방위(Theta)까지 정확하게 확인하게 만듭니다.
            window.cmdAdjustRobotPosition();
        };
    };
    mapInteraction(document.getElementById('mapCanvas'));
    mapInteraction(document.getElementById('setupMapCanvas'));
}

// -----------------------------------------------
// Initialization
// -----------------------------------------------
window.onload = () => {
    logMirSystemData("시스템 초기화 중...", "ok");

    const setupMapCanvas = document.getElementById('setupMapCanvas');

    mirCtrl.init(mapCanvas, (msg) => {
        // MiR controller log callback — suppress or forward
    }, (state, extra) => {
        // MiR status update callback
        const elNameSetup = document.getElementById('mirRobotNameSetup');
        const elSerialSetup = document.getElementById('mirSerialSetup');
        if (elNameSetup) elNameSetup.innerText = state.robot_name || "MiR AMR";
        if (elSerialSetup) elSerialSetup.innerText = state.serial_number || "Unknown";

        const elState = document.getElementById('mirStateText');
        const elBat = document.getElementById('mirBattery');
        const elErrors = document.getElementById('mirErrorCount');
        const elBatTime = document.getElementById('mirBatteryTime');
        const elUptime = document.getElementById('mirUptime');
        const elMoved = document.getElementById('mirMoved');

        if (elState) {
            elState.innerText = state.text || "—";
            elState.style.color = state.id === 3 ? "#4ade80" : state.id === 11 ? "#e57373" : "#facc15";
        }
        if (elBat) elBat.innerText = `${(state.battery || 0).toFixed(1)}%`;
        if (elErrors) elErrors.innerText = (state.errors || []).length > 0 ? `${state.errors.length} Error(s)` : 'OK';
        if (elBatTime) {
            const secs = state.battery_time_remaining;
            elBatTime.innerText = secs != null ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m` : "N/A";
        }
        if (elUptime) {
            const s = state.uptime;
            elUptime.innerText = s != null ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : "N/A";
        }
        if (elMoved) {
            elMoved.innerText = state.moved_distance != null ? `${(state.moved_distance / 1000).toFixed(2)} km` : "N/A";
        }

        if (extra && extra.positionsLoaded) {
            updateWaypointCheckboxes();
            updateMirPositionsList();
        }
    }, setupMapCanvas);

    // UR Controller: set log callback and start all subscribers
    urCtrl.setLogCallback(logUr);
    urCtrl.startLogSubscriber();

    urCtrl.startRosoutSubscriber((msg) => {
        const m = msg.match(/\[([^\]]+)\]\s*(.*)/);
        const node = m ? m[1] : "ros";
        const body = m ? m[2] : msg;
        const level = body.toLowerCase().includes("error") ? "ERROR" : body.toLowerCase().includes("warn") ? "WARN" : "INFO";
        appendLogRow('rosoutTbody', level, node, body);
    });

    const imgStream = document.getElementById('camera-stream');
    urCtrl.startCameraSubscriber((b64) => {
        if (imgStream) imgStream.src = "data:image/jpeg;base64," + b64;
    });

    // UR state monitoring for main dashboard
    startUrStateSubscribers();
    startUrEstopMonitor();

    // Wire up map overlay checkboxes
    wireMapCheckboxes();

    // Topic heartbeat monitor (Setup tab)
    setInterval(pollTopicHeartbeats, 2000);

    // Detailed log & Status polling
    setTimeout(() => { window.fetchAndRenderUserMissions(); }, 1500);
    setInterval(() => { window.pollDetailedLogs(); }, 1000); // 1초 간격으로 폴링 주기 단축하여 실시간성 확보

    // MiR diagnostics polling
    setInterval(() => { fetchDiagnosticsAPI(); }, 3000);

    // MiR LiDAR Scan & Robot Coordinate polling
    setInterval(() => { fetchProtectiveScanAPI(); }, 500); // 위치 및 라이다 스캔 주기 단축 (0.5초)

    // Render scenario buttons and init 3D viewer
    renderScenarioButtons();
    initROS3DViewer();

    logUr("[INFO] ROS2 pipeline initialized.");
    logMirSystemData("시스템 초기화 완료.", "ok");
};