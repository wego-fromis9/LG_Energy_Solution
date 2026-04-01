const config = require('./config');

class MiRController {
    constructor() {
        this.ctx = null;
        this.canvas = null;
        this.onLog = null;
        this.onStatusUpdate = null;

        this.state = {
            id: 0,
            text: "Unknown",
            x: 0, y: 0, theta: 0,
            battery: 0,
            errors: []
        };

        this.map = {
            currentId: null,
            baseImage: null,
            resolution: 0.05,
            originX: 0, originY: 0,
            positions: [],
            waypoints: [],
            chargers: []
        };
        this.setupCanvas = null;
        this.setupCtx = null;

        this.missions = { moveGuid: null, dockGuid: null };
        this.sequence = [];
        this.isPatrolling = false;

        // UI Checkboxes
        this.showWaypoints = true;
        this.showChargers = true;
        this.showGrid = false;

        this.imgWaypoint = new Image();
        this.imgWaypoint.onload = () => this.drawMap();
        this.imgWaypoint.src = 'images/waypoint.png';
        
        this.imgCharger = new Image();
        this.imgCharger.onload = () => this.drawMap();
        this.imgCharger.src = 'images/charger.png';
    }

    init(canvasElement, logCallback, statusCallback, setupCanvasElement = null) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        if (setupCanvasElement) {
            this.setupCanvas = setupCanvasElement;
            this.setupCtx = setupCanvasElement.getContext('2d');
        }
        this.onLog = logCallback;
        this.onStatusUpdate = statusCallback;

        setInterval(() => this.pollStatus(), config.mir.pollIntervalMs);
        this.pollStatus();
        this.fetchBaseMissions();
    }

    _log(msg) {
        if (this.onLog) this.onLog(msg);
    }

    getAuthHeader() {
        const crypto = require('crypto');
        const pwHash = crypto.createHash('sha256').update(config.mir.pw).digest('hex');
        const authB64 = Buffer.from(`${config.mir.id}:${pwHash}`).toString('base64');
        return {
            "Content-Type": "application/json",
            "Accept-Language": "ko_KR.utf8",
            "Authorization": `Basic ${authB64}`
        };
    }

    getBaseUrl() {
        let host = config.mir.defaultHost;
        const hostInput = document.getElementById('inputHost');
        if (hostInput && hostInput.value) {
            host = hostInput.value.trim();
        }
        if (!host.startsWith('http')) {
            host = `http://${host}`;
        }
        return `${host}/api/v2.0.0`;
    }

    async pollStatus() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/status`, { headers: this.getAuthHeader() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this.state.id = data.state_id || 0;
            this.state.text = data.state_text || "Unknown";
            this.state.battery = data.battery_percentage || 0.0;
            this.state.errors = data.errors || [];
            this.state.robot_name = data.robot_name || "MiR AMR";
            this.state.serial_number = data.serial_number || "Unknown";
            this.state.mission_text = data.mission_text || "—";
            this.state.temperature = data.temperature != null ? data.temperature.toFixed(1) : null;
            this.state.battery_time_remaining = data.battery_time_remaining != null ? data.battery_time_remaining : null;
            this.state.uptime = data.uptime != null ? data.uptime : null;
            this.state.moved_distance = data.moved != null ? data.moved : null;

            const pos = data.position || {};
            this.state.x = pos.x || 0.0;
            this.state.y = pos.y || 0.0;
            this.state.theta = pos.orientation || 0.0;

            if (this.onStatusUpdate) this.onStatusUpdate(this.state, data);

            if (data.map_id && this.map.currentId !== data.map_id) {
                await this.loadMap(data.map_id);
            }
            if (this.map.baseImage) this.drawMap();

        } catch (e) { /* ignore connection silent errors or log them slightly */ }
    }

    async fetchBaseMissions() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/missions`, { headers: this.getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();
            this.missions.all = data; // Store all
            data.forEach(m => {
                const name = (m.name || "").toLowerCase();
                if (name.includes("move") || name.includes("go")) this.missions.moveGuid = m.guid;
                if (name.includes("charge") || name.includes("dock")) this.missions.dockGuid = m.guid;
            });
            if (this.onStatusUpdate) this.onStatusUpdate(this.state, { missionsLoaded: true });
        } catch (e) { }
    }

    // Returns { builtinGroupIds: Set<string>, allGroups: Array }
    // MiR built-in groups are identified by having 'feature' flag or name starting with 'MiR'
    async fetchMissionGroups() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/mission_groups`, { headers: this.getAuthHeader() });
            if (!res.ok) return { builtinGroupIds: new Set(), allGroups: [] };
            const groups = await res.json();
            // Built-in MiR groups: typically have feature == true, or name starts with 'MiR'
            const builtinGroupIds = new Set(
                groups
                    .filter(g => g.feature === true || (g.name || '').startsWith('MiR') || (g.name || '').startsWith('mir'))
                    .map(g => g.guid)
            );
            return { builtinGroupIds, allGroups: groups };
        } catch (e) {
            return { builtinGroupIds: new Set(), allGroups: [] };
        }
    }

    // Force reload map even if same mapGuid
    async forceReloadMap() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/status`, { headers: this.getAuthHeader() });
            if (!res.ok) return false;
            const data = await res.json();
            const mapId = data.map_id;
            if (!mapId) return false;
            this.map.currentId = null; // Reset so loadMap proceeds
            await this.loadMap(mapId);
            return true;
        } catch (e) { return false; }
    }

    async loadMap(mapGuid) {
        try {
            const res = await fetch(`${this.getBaseUrl()}/maps/${mapGuid}`, { headers: this.getAuthHeader() });
            if (!res.ok) return;
            const data = await res.json();

            this.map.resolution = data.resolution || 0.05;
            this.map.originX = data.origin_x || 0.0;
            this.map.originY = data.origin_y || 0.0;

            let b64 = data.map || data.base_map || "";
            if (b64.includes(",")) b64 = b64.split(",")[1];

            if (b64) {
                const img = new Image();
                img.onload = () => {
                    this.map.baseImage = img;
                    this.map.currentId = mapGuid;
                    this.drawMap();
                };
                img.src = `data:image/png;base64,${b64}`;
            }
            await this.updatePositions(mapGuid);
        } catch (e) { }
    }

    async updatePositions(mapGuid) {
        try {
            const res = await fetch(`${this.getBaseUrl()}/maps/${mapGuid}/positions`, { headers: this.getAuthHeader() });
            if (!res.ok) return;
            const posList = await res.json();

            // Fetch details in parallel for positions
            const detailPromises = posList.map(async p => {
                if (!p.guid) return null;
                const dRes = await fetch(`${this.getBaseUrl()}/positions/${p.guid}`, { headers: this.getAuthHeader() });
                if (dRes.ok) return await dRes.json();
                return null;
            });
            const detailedPositions = (await Promise.all(detailPromises)).filter(p => p !== null);

            this.map.positions = detailedPositions;
            this.map.waypoints = this.map.positions.filter(p => p.type_id === 0);
            this.map.chargers = this.map.positions.filter(p => p.type_id === 7);

            if (this.onStatusUpdate) this.onStatusUpdate(this.state, { positionsLoaded: true });
        } catch (e) { }
    }

    drawMap() {
        if (!this.map.baseImage || !this.ctx) return;

        this.canvas.width = this.map.baseImage.width;
        this.canvas.height = this.map.baseImage.height;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.map.baseImage, 0, 0);

        if (this.setupCanvas && this.setupCtx) {
            this.setupCanvas.width = this.map.baseImage.width;
            this.setupCanvas.height = this.map.baseImage.height;
            this.setupCtx.clearRect(0, 0, this.setupCanvas.width, this.setupCanvas.height);
            this.setupCtx.drawImage(this.map.baseImage, 0, 0);
        }        const h = this.map.baseImage.height;
        const w = this.map.baseImage.width;
        const r = this.map.resolution > 0 ? this.map.resolution : 0.05;
        const ox = this.map.originX, oy = this.map.originY;

        // --- Metric Grid Layer ---
        if (this.showGrid) {
            const gridSpacingPx = 1.0 / r; 
            [this.ctx, this.setupCtx].forEach(ctx => {
                if (!ctx) return;
                ctx.beginPath();
                ctx.strokeStyle = "rgba(0, 255, 0, 0.8)"; 
                ctx.lineWidth = 1.0;
                
                const startX = (((-ox / r) % gridSpacingPx) + gridSpacingPx) % gridSpacingPx;
                for (let x = startX; x <= w; x += gridSpacingPx) {
                    ctx.moveTo(x, 0); ctx.lineTo(x, h);
                }
                const startY = (((-oy / r) % gridSpacingPx) + gridSpacingPx) % gridSpacingPx;
                for (let y = h - startY; y >= 0; y -= gridSpacingPx) {
                    ctx.moveTo(0, y); ctx.lineTo(w, y);
                }
                for (let y = h - startY; y <= h; y += gridSpacingPx) {
                    ctx.moveTo(0, y); ctx.lineTo(w, y);
                }
                ctx.stroke();
            });
            console.log(`[DEBUG] Grid lines drawn successfully (Green). w=${w}, h=${h}, spacingPx=${gridSpacingPx}`);
        }

        // Map elements (Waypoints / Chargers)
        this.map.positions.forEach(p => {
            if (p.pos_x == null || p.pos_y == null) return;
            const px = (p.pos_x - ox) / r;
            const py = h - ((p.pos_y - oy) / r);
            
            if (p.type_id === 7 && this.showChargers) {
                const sz = 16;
                if (this.ctx) this.ctx.drawImage(this.imgCharger, px - sz/2, py - sz/2, sz, sz);
                if (this.setupCtx) this.setupCtx.drawImage(this.imgCharger, px - sz/2, py - sz/2, sz, sz);
            } else if ((p.type_id === 0 || p.type_id === 11) && this.showWaypoints) {
                const sz = 16;
                const theta = p.orientation != null ? p.orientation : 0;
                [this.ctx, this.setupCtx].forEach(c => {
                    if (c) {
                        c.save();
                        c.translate(px, py);
                        c.rotate(-theta * (Math.PI / 180));
                        c.drawImage(this.imgWaypoint, -sz/2, -sz/2, sz, sz);
                        c.restore();
                    }
                });
            }
        });
        
        // Resolution Text (Overlay)
        this.ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        this.ctx.font = "bold 11px Roboto Mono, monospace";
        this.ctx.textAlign = "right";
        this.ctx.shadowColor = "black";
        this.ctx.shadowBlur = 4;
        this.ctx.fillText(`Scale: 1.0m/grid | Res: ${r.toFixed(3)} m/px`, w - 10, h - 10);
        this.ctx.shadowBlur = 0;
    }

    getMissionName(urlOrGuid) {
        if (!this.missions.all || !urlOrGuid) return null;
        // GUID might be at the end of a URL: /api/v2.0.0/missions/guid
        const parts = urlOrGuid.split('/');
        const guid = parts[parts.length - 1];

        const found = this.missions.all.find(m => m.guid === guid);
        return found ? found.name : null;
    }

    async pollEventLogs(lastErrorId, lastMissionId) {
        let newErrors = [];
        let newMissions = [];
        try {
            // 1. Fetch System Error Reports
            const errRes = await fetch(`${this.getBaseUrl()}/log/error_reports`, { headers: this.getAuthHeader() });
            if (errRes.ok) {
                const errLogs = await errRes.json();
                let latestErrSummaries = errLogs.filter(e => e.id > lastErrorId);
                if (latestErrSummaries.length > 10) latestErrSummaries = latestErrSummaries.slice(-10);

                for (let s of latestErrSummaries) {
                    const detailRes = await fetch(`${this.getBaseUrl()}/log/error_reports/${s.id}`, { headers: this.getAuthHeader() });
                    if (detailRes.ok) {
                        const d = await detailRes.json();
                        newErrors.push({
                            id: d.id,
                            module: d.module || 'Unknown',
                            message: d.description || 'No description',
                            time: d.time || new Date().toISOString()
                        });
                    }
                }
            }

            // 2. Fetch Mission Queue Execution Logs
            const mRes = await fetch(`${this.getBaseUrl()}/mission_queue`, { headers: this.getAuthHeader() });
            if (mRes.ok) {
                const missions = await mRes.json();
                let latestMissions = missions.filter(m => m.id > lastMissionId);
                if (latestMissions.length > 10) latestMissions = latestMissions.slice(-10);

                for (let s of latestMissions) {
                    const detailRes = await fetch(`${this.getBaseUrl()}/mission_queue/${s.id}`, { headers: this.getAuthHeader() });
                    if (detailRes.ok) {
                        const d = await detailRes.json();
                        newMissions.push({
                            id: d.id,
                            state: d.state || 'Unknown',
                            mission_id: d.mission_id ? String(d.mission_id).substring(0,20) : 'Unknown',
                            message: d.message || 'No message',
                            time: d.finished || d.started || new Date().toISOString()
                        });
                    }
                }
            }
        } catch(e) { 
            console.error(`[MiR API] Log Poll Error: ${e.message}`);
        }
        return { newErrors, newMissions };
    }

    async postMission(missionGuid, posGuid = null) {
        if (!missionGuid) return this._log("[Error] Mission GUID Not Found");

        try {
            if (this.state.id !== 3 && this.state.id !== 4) {
                await fetch(`${this.getBaseUrl()}/status`, {
                    method: 'PUT', headers: this.getAuthHeader(), body: JSON.stringify({ state_id: 3 })
                });
            }
            const payload = { mission_id: missionGuid };
            if (posGuid) payload.parameters = [{ input_name: "position", value: posGuid }];

            let res = await fetch(`${this.getBaseUrl()}/mission_queue`, {
                method: 'POST', headers: this.getAuthHeader(), body: JSON.stringify(payload)
            });
            if (!res.ok && res.status === 400 && posGuid) {
                payload.parameters = [{ input_name: "marker", value: posGuid }];
                res = await fetch(`${this.getBaseUrl()}/mission_queue`, {
                    method: 'POST', headers: this.getAuthHeader(), body: JSON.stringify(payload)
                });
            }
        } catch (e) { }
    }

    async setInitialPosition(x, y, theta) {
        try {
            const res = await fetch(`${this.getBaseUrl()}/status`, {
                method: 'PUT',
                headers: this.getAuthHeader(),
                body: JSON.stringify({
                    position: { x, y, orientation: theta }
                })
            });
            if (res.ok) {
                this._log(`[SUCCESS] 초기 위치 설정 완료: (${x.toFixed(2)}, ${y.toFixed(2)}, ${theta.toFixed(2)})`);
                return true;
            } else {
                this._log(`[ERROR] 초기 위치 설정 실패: ${res.status}`);
                return false;
            }
        } catch (e) {
            this._log(`[ERROR] 초기 위치 설정 예외: ${e.message}`);
            return false;
        }
    }

    async getMissionQueue() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/mission_queue`, { headers: this.getAuthHeader() });
            if (!res.ok) return [];
            return await res.json();
        } catch (e) { return []; }
    }

    async clearMissionQueue() {
        try {
            const res = await fetch(`${this.getBaseUrl()}/mission_queue`, {
                method: 'DELETE', headers: this.getAuthHeader()
            });
            if (res.ok) {
                this._log("[INFO] 미션 큐가 초기화되었습니다.");
            } else {
                this._log(`[WARN] 큐 초기화 중 서버 응답: ${res.status}`);
            }
        } catch (e) {
            this._log(`[ERROR] 큐 초기화 실패: ${e.message}`);
        }
    }
}

module.exports = new MiRController();
