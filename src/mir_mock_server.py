from flask import Flask, jsonify, request
import time
import math

app = Flask(__name__)
start_time = time.time()

# [CRITICAL FIX] Persist State
current_mir_state_id = 3
current_mir_state_text = "Ready"

@app.route('/api/v2.0.0/status', methods=['GET', 'PUT'])
def status():
    global current_mir_state_id, current_mir_state_text
    
    if request.method == 'PUT':
        data = request.json
        if data and 'state_id' in data:
            req_state = data['state_id']
            # According to manual pg 387, PUT status only accepts 3, 4, 11
            if req_state in [3, 4, 11]:
                current_mir_state_id = req_state
                if current_mir_state_id == 3: current_mir_state_text = "Ready"
                elif current_mir_state_id == 4: current_mir_state_text = "Pause"
                elif current_mir_state_id == 11: current_mir_state_text = "Manual control"
        return jsonify({"success": True})
    
    t = (time.time() - start_time) / 3.0
    robot_x = 20.0 + 10.0 * math.sin(t)
    robot_y = 20.0 + 10.0 * math.cos(t)
    orientation = (math.degrees(-t) % 360) 
    
    return jsonify({
        "state_id": current_mir_state_id,
        "state_text": current_mir_state_text,
        "mission_text": "가상 주행 테스트 중..." if current_mir_state_id == 5 else "...",
        "battery_percentage": 85.5,
        "battery_time_remaining": 9000, 
        "uptime": int(time.time() - start_time),
        "moved_distance": 1234.5,
        "map_id": "mock-map-1234",
        "position": { "x": robot_x, "y": robot_y, "orientation": orientation },
        "errors": []
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
