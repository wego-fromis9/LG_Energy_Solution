const { exec, spawn } = require('child_process');
const config = require('./config');

class URController {
    constructor() {
        this.logProcess = null;
        this.jointProcess = null;
        this.rosoutProcess = null;
        this.cameraProcess = null;
        this.lidarProcess = null;
        this.onLogCallback = null;

        // Activity Monitoring
        this.lastHeartbeat = {
            joint: null,
            rosout: null,
            log: null,
            camera: null,
            lidar: null
        };
    }

    setLogCallback(cb) {
        this.onLogCallback = cb;
    }

    _log(msg) {
        if(this.onLogCallback) this.onLogCallback(msg);
    }

    // Publisher for arbitrary float array control
    publishControl(floatArray) {
        // e.g., floatArray = [1.5, 2.0, 3.1]
        const listStr = floatArray.join(', ');
        const cmd = `bash -c "source /opt/ros/humble/setup.bash && ros2 topic pub --once ${config.ur.controlTopic} std_msgs/msg/Float32MultiArray '{data: [${listStr}]}'"`;
        
        exec(cmd, (err) => {
            if(err) this._log(`[ERROR] 제어 명령 전송 실패: ${err.message}`);
            else this._log(`[SUCCESS] 수동 제어 전송 완료: [${listStr}]`);
        });
        this._log(`[INFO] 제어 명령 전송 중: ${config.ur.controlTopic} -> [${listStr}]`);
    }

    // Publisher for scenario Bool Trigger
    publishScenario(topic) {
        this.publishBoolTrigger(topic);
        this._log(`[INFO] 시나리오 호출 중 (Bool): ${topic}`);
    }

    // Generic Bool Trigger (--once)
    publishBoolTrigger(topic) {
        const cmd = `bash -c "source /opt/ros/humble/setup.bash && ros2 topic pub --once ${topic} std_msgs/msg/Bool '{data: true}'"`;
        exec(cmd, (err) => {
            if(err) this._log(`[ERROR] Bool trigger failed on ${topic}: ${err.message}`);
            else this._log(`[OK] Published Bool true -> ${topic}`);
        });
    }

    publishManualMode() { this.publishBoolTrigger(config.ur.manualModeTopic); }
    publishUnlock()     { this.publishBoolTrigger(config.ur.unlockTopic); }
    publishEstop()      { this.publishBoolTrigger(config.ur.estopTopic); }

    // Publisher for scenario Float32 ID (e.g., /scenario_trigger)
    publishScenarioById(id) {
        const cmd = `bash -c "source /opt/ros/humble/setup.bash && ros2 topic pub --once ${config.ur.scenarioTopic} std_msgs/msg/Float32 '{data: ${id}}'"`;
        exec(cmd, (err) => {
            if(err) this._log(`[ERROR] 시나리오 호출 실패 (${id}): ${err.message}`);
            else this._log(`[OK] Published Scenario ID ${id} -> ${config.ur.scenarioTopic}`);
        });
    }

    // Echo String Log Topic
    startLogSubscriber() {
        if (this.logProcess) return;
        
        this._log(`[INFO] UR 로그 수신을 시작합니다. (${config.ur.logTopic})`);
        const cmd = `source /opt/ros/humble/setup.bash && stdbuf -o0 ros2 topic echo ${config.ur.logTopic}`;
        this.logProcess = spawn('bash', ['-c', cmd]);
        
        this.logProcess.stdout.on('data', (d) => {
            const lines = d.toString().split('\n');
            lines.forEach(l => {
                if (l.includes('data:')) {
                    this.lastHeartbeat.log = new Date();
                    this._log(`[UR log] ${l.replace('data:', '').trim()}`);
                }
            });
        });
        
        this.logProcess.stderr.on('data', (d) => {
            // Only log real errors from stderr, not ROS init noise
            const line = d.toString();
            if (line.includes('[FATAL]') || line.includes('[ERROR]')) {
                this._log(`[ERROR] ${line.trim()}`);
            }
        });

        this.logProcess.on('close', () => {
            this.logProcess = null;
        });
    }

    stopLogSubscriber() {
        if (this.logProcess) {
            this.logProcess.kill();
            this.logProcess = null;
            this._log(`[INFO] UR 로그 수신 중단됨.`);
        }
    }

    // rosout global log subscriber
    startRosoutSubscriber(callback) {
        if (this.rosoutProcess) return;
        const cmd = `source /opt/ros/humble/setup.bash && stdbuf -oL ros2 topic echo ${config.ur.rosoutTopic} rcl_interfaces/msg/Log`;
        this.rosoutProcess = spawn('bash', ['-c', cmd]);
        let buf = "";
        this.rosoutProcess.stdout.on('data', (d) => {
            buf += d.toString();
            const parts = buf.split('---');
            while(parts.length > 1) {
                const chunk = parts.shift();
                buf = parts.join('---');
                const m = chunk.match(/msg:\s*([^\n]+)/);
                const n = chunk.match(/name:\s*([^\n]+)/);
                if (m) {
                    this.lastHeartbeat.rosout = new Date();
                    callback(`[${n ? n[1].trim() : 'ros'}] ${m[1].trim()}`);
                }
            }
        });
        this.rosoutProcess.on('close', () => { this.rosoutProcess = null; });
    }

    stopRosoutSubscriber() {
        if (this.rosoutProcess) { this.rosoutProcess.kill(); this.rosoutProcess = null; }
    }

    // Echo Joint States Topic for 3D Viewer
    startJointSubscriber(callback) {
        if (this.jointProcess) return;
        const cmd = `source /opt/ros/humble/setup.bash && stdbuf -oL ros2 topic echo ${config.ur.jointTopic} sensor_msgs/msg/JointState`;
        
        this.jointProcess = spawn('bash', ['-c', cmd]);
        let buffer = "";

        this.jointProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            const parts = buffer.split('---');
            while (parts.length > 1) {
                const chunk = parts.shift();
                buffer = parts.join('---');

                let names = [];
                let positions = [];

                // Try Flow Style first: name: [a, b, c]
                const nameFlow = chunk.match(/name:\s*\[([^\]]+)\]/);
                const posFlow = chunk.match(/position:\s*\[([^\]]+)\]/);

                if (nameFlow && posFlow) {
                    names = nameFlow[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
                    positions = posFlow[1].split(',').map(s => parseFloat(s.trim()));
                } else {
                    // Fallback to Block Style: - name
                    const nameBlock = chunk.match(/name:\s*\n((?:\s*-[^\n]+\n?)*)/);
                    const posBlock = chunk.match(/position:\s*\n((?:\s*-[^\n]+\n?)*)/);
                    if (nameBlock && posBlock) {
                        names = nameBlock[1].split('\n').filter(l => l.includes('-')).map(l => l.replace('-','').trim().replace(/['"]/g, ''));
                        positions = posBlock[1].split('\n').filter(l => l.includes('-')).map(l => parseFloat(l.replace('-','').trim()));
                    }
                }

                if (names.length > 0 && names.length === positions.length) {
                    this.lastHeartbeat.joint = new Date();
                    const jointData = {};
                    for (let i = 0; i < names.length; i++) {
                        jointData[names[i]] = positions[i];
                    }
                    if(callback) callback(jointData);
                }
            }
        });

        this.jointProcess.on('close', () => { this.jointProcess = null; });
    }

    stopJointSubscriber() {
        if (this.jointProcess) { this.jointProcess.kill('SIGINT'); this.jointProcess = null; }
    }

    startCameraSubscriber(callback) {
        if (this.cameraProcess) return;
        this._log(`[INFO] 카메라 피드 수신을 시작합니다. (${config.ur.cameraTopic})`);
        
        // Use full path to the helper script
        const scriptPath = require('path').join(__dirname, 'camera_streamer.py');
        this.cameraProcess = spawn('python3', [scriptPath, config.ur.cameraTopic]);

        let camBuffer = '';
        this.cameraProcess.stdout.on('data', (d) => {
            camBuffer += d.toString();
            let newlineIdx;
            while ((newlineIdx = camBuffer.indexOf('\n')) !== -1) {
                const b64 = camBuffer.slice(0, newlineIdx).trim();
                camBuffer = camBuffer.slice(newlineIdx + 1);
                
                if (b64) {
                    this.lastHeartbeat.camera = new Date();
                    if (callback) callback(b64);
                }
            }
        });

        this.cameraProcess.on('close', () => { this.cameraProcess = null; });
    }

    stopCameraSubscriber() {
        if (this.cameraProcess) { this.cameraProcess.kill(); this.cameraProcess = null; }
    }

    // LiDAR /scan subscriber: emits { ranges, angleMin, angleMax, angleIncrement, rangeMin, rangeMax }
    startLidarSubscriber(callback) {
        if (this.lidarProcess) return;
        const cmd = `source /opt/ros/humble/setup.bash && stdbuf -oL ros2 topic echo /scan sensor_msgs/msg/LaserScan`;
        this.lidarProcess = spawn('bash', ['-c', cmd]);
        let buf = '';

        this.lidarProcess.stdout.on('data', (d) => {
            buf += d.toString();
            const parts = buf.split('---');
            while (parts.length > 1) {
                const chunk = parts.shift();
                buf = parts.join('---');

                try {
                    const angleMin    = parseFloat((chunk.match(/angle_min:\s*([\d\.eE+\-]+)/) || [])[1]);
                    const angleMax    = parseFloat((chunk.match(/angle_max:\s*([\d\.eE+\-]+)/) || [])[1]);
                    const angleInc    = parseFloat((chunk.match(/angle_increment:\s*([\d\.eE+\-]+)/) || [])[1]);
                    const rangeMin    = parseFloat((chunk.match(/range_min:\s*([\d\.eE+\-]+)/) || [])[1]);
                    const rangeMax    = parseFloat((chunk.match(/range_max:\s*([\d\.eE+\-]+)/) || [])[1]);

                    // Parse ranges array
                    const rangesBlock = chunk.match(/ranges:\s*\n((?:\s*- [^\n]+\n)*)/);
                    if (!rangesBlock || isNaN(angleMin) || isNaN(angleInc)) continue;

                    const ranges = rangesBlock[1].split('\n')
                        .filter(l => l.includes('-'))
                        .map(l => parseFloat(l.replace('-', '').trim()))
                        .filter(v => !isNaN(v));

                    this.lastHeartbeat.lidar = new Date();
                    if (callback) callback({ ranges, angleMin, angleMax, angleIncrement: angleInc, rangeMin, rangeMax });
                } catch (e) { /* ignore parse errors */ }
            }
        });

        this.lidarProcess.stderr.on('data', () => {}); // suppress stderr
        this.lidarProcess.on('close', () => { this.lidarProcess = null; });
    }

    stopLidarSubscriber() {
        if (this.lidarProcess) { this.lidarProcess.kill(); this.lidarProcess = null; }
    }
}

module.exports = new URController();
