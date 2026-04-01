from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from PIL import Image, ImageDraw
import time
import math
import io
import base64

app = Flask(__name__)
# 대시보드(브라우저)에서 로컬 서버로 API 요청을 보낼 수 있도록 CORS 허용
CORS(app)

# 서버 시작 시간
start_time = time.time()
mock_mission_queue = []

def get_blank_map_b64():
    """가상의 800x800 맵 이미지를 생성하여 Base64로 반환합니다. (해상도 0.05m 기준 40m x 40m)"""
    img = Image.new('RGBA', (800, 800), (245, 245, 245, 255))
    draw = ImageDraw.Draw(img)
    # 배경에 십자선(그리드 느낌) 그리기
    draw.line((400, 0, 400, 800), fill=(200, 200, 200, 255), width=2)
    draw.line((0, 400, 800, 400), fill=(200, 200, 200, 255), width=2)
    
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')

# 한 번만 생성해서 메모리에 캐싱
cached_map_b64 = get_blank_map_b64()

@app.route('/api/v2.0.0/status', methods=['GET', 'PUT'])
def status():
    """로봇의 실시간 상태와 위치를 반환 (웨이포인트 하이라이팅 테스트용)"""
    if request.method == 'PUT':
        # Play, Pause, Error Clear 등 상태 변경 요청 성공 처리
        return jsonify({"success": True})
    
    # 시간이 지남에 따라 가상 로봇이 (20,20) 좌표를 중심으로 반지름 10m의 원을 그리며 주행합니다.
    t = (time.time() - start_time) / 3.0 # 주행 속도 조절
    robot_x = 20.0 + 10.0 * math.sin(t)
    robot_y = 20.0 + 10.0 * math.cos(t)
    orientation = (math.degrees(-t) % 360) 
    
    return jsonify({
        "state_id": 3,
        "state_text": "Ready",
        "mission_text": "가상 주행 테스트 중...",
        "battery_percentage": 85.5,
        "battery_time_remaining": 3600,
        "uptime": int(time.time() - start_time),
        "moved_distance": 1234.5,
        "map_id": "mock-map-1234",
        "position": {
            "x": robot_x,
            "y": robot_y,
            "orientation": orientation
        },
        "errors": []
    })

@app.route('/api/v2.0.0/maps/<map_id>', methods=['GET'])
def map_detail(map_id):
    """맵의 메타데이터와 이미지를 반환합니다."""
    return jsonify({
        "resolution": 0.05,
        "origin_x": 0.0,
        "origin_y": 0.0,
        "base_map": cached_map_b64
    })

@app.route('/api/v2.0.0/maps/<map_id>/positions', methods=['GET'])
def positions(map_id):
    """로봇이 주행하는 궤적(반지름 10m 원) 위에 웨이포인트를 배치합니다."""
    return jsonify([
        {"guid": "wp-top", "name": "북쪽 웨이포인트", "pos_x": 20.0, "pos_y": 30.0, "type_id": 0, "orientation": 0},
        {"guid": "wp-right", "name": "동쪽 웨이포인트", "pos_x": 30.0, "pos_y": 20.0, "type_id": 0, "orientation": 90},
        {"guid": "wp-bottom", "name": "남쪽 웨이포인트", "pos_x": 20.0, "pos_y": 10.0, "type_id": 0, "orientation": 180},
        {"guid": "wp-left", "name": "서쪽 웨이포인트", "pos_x": 10.0, "pos_y": 20.0, "type_id": 0, "orientation": -90},
        {"guid": "charge-1", "name": "충전소", "pos_x": 2.0, "pos_y": 2.0, "type_id": 7, "orientation": 0}
    ])

@app.route('/api/v2.0.0/system/protective_scan', methods=['GET'])
def protective_scan():
    """라이다(LiDAR) 스캔 이미지를 가짜로 생성하여 반환 (라이다 레이어링 렌더링 테스트용)"""
    # 200x200 이미지 (해상도 0.05m 기준 10m x 10m 크기)
    img = Image.new('RGBA', (200, 200), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 디버깅하기 쉽도록 초록색 윤곽선의 원을 그립니다.
    draw.ellipse((10, 10, 190, 190), outline=(0, 255, 0, 200), width=4)
    # 로봇 앞을 막는 가상의 장애물 (빨간색 선)
    draw.line((150, 50, 150, 150), fill=(255, 0, 0, 200), width=6)
    
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png')

@app.route('/api/v2.0.0/missions', methods=['GET'])
def get_missions():
    """사용자 미션 목록 (미션 큐 UI 동기화 테스트용)"""
    return jsonify([
        {"guid": "mission-guid-1", "name": "물품 운반 미션"},
        {"guid": "mission-guid-2", "name": "충전소 복귀 미션"},
        {"guid": "mission-guid-3", "name": "구역 순찰 미션"}
    ])

@app.route('/api/v2.0.0/mission_queue', methods=['GET', 'POST', 'DELETE'])
def mission_queue():
    """미션 큐 상태 관리"""
    global mock_mission_queue
    if request.method == 'DELETE':
        mock_mission_queue = []
        return "", 204
        
    if request.method == 'POST':
        data = request.json
        mission_id = data.get("mission_id")
        mock_mission_queue.append({
            "id": len(mock_mission_queue) + 1,
            "state": "Executing", # 등록되자마자 실행 상태로 가정
            "mission_id": f"/api/v2.0.0/missions/{mission_id}"
        })
        return jsonify({"id": len(mock_mission_queue)}), 201
        
    return jsonify(mock_mission_queue)

@app.route('/api/v2.0.0/mission_queue/<int:mq_id>', methods=['GET'])
def mission_queue_detail(mq_id):
    """큐 상세 정보 (로깅용)"""
    for m in mock_mission_queue:
        if m["id"] == mq_id:
            return jsonify({
                "id": mq_id,
                "state": m["state"],
                "mission_id": m["mission_id"],
                "message": "가상 미션을 성공적으로 처리하고 있습니다."
            })
    return jsonify({"error": "not found"}), 404

@app.route('/api/v2.0.0/log/sys_log', methods=['GET'])
def sys_log():
    """실시간 시스템 로그 생성기 (10초마다 새 로그를 생성)"""
    current_time = time.time()
    log_id = int((current_time - start_time) / 5) # 5초마다 로그 1개씩 증가
    
    logs = []
    # 최근 5개의 로그만 반환 (대시보드의 lastFetchedSysLogId 로직이 이를 필터링함)
    for i in range(max(0, log_id - 5), log_id + 1):
        log_level = "Warning" if i % 4 == 0 else "Error" if i % 7 == 0 else "Info"
        logs.append({
            "id": i,
            "module": "MockSystemLogger",
            "description": f"가상 로봇 시스템 이벤트 발생 테스트 번호: {i} ({log_level})",
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(start_time + i * 5))
        })
    return jsonify(logs)

@app.route('/api/v2.0.0/log/error_reports', methods=['GET'])
def error_reports():
    return jsonify([])

@app.route('/api/v2.0.0/experimental/diagnostics', methods=['GET'])
def diagnostics():
    return jsonify([{"level": 0, "module": "MockDiagnostics", "message": "All systems operating normally."}])

if __name__ == '__main__':
    print("=====================================================")
    print("🤖 MiR Mock Server가 시작되었습니다.")
    print("👉 대시보드의 호스트 주소(ADDRESS)에 [ 127.0.0.1:8080 ]을 입력하세요.")
    print("=====================================================")
    app.run(host='0.0.0.0', port=8080, debug=False)