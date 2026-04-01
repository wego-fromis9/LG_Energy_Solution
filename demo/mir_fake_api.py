import rclpy
from rclpy.node import Node
from turtlesim.msg import Pose
from rcl_interfaces.msg import Log
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
import threading
import random
import math
import time
import io
import base64
from PIL import Image

app = Flask(__name__)
CORS(app)

robot_data = {"x": 5.5, "y": 5.5, "theta": 0.0, "linear_v": 0.0, "angular_v": 0.0}
rosout_logs = []
mission_queue = []

waypoints = [
    {"guid": f"wp-{i}", "name": f"Waypoint {i}", "pos_x": random.uniform(2.0, 9.0), "pos_y": random.uniform(2.0, 9.0), "type_id": 0, "orientation": random.uniform(0, 360)}
    for i in range(1, 4)
]

class MirBridgeNode(Node):
    def __init__(self):
        super().__init__('mir_bridge_node')
        self.create_subscription(Pose, '/turtle1/pose', self.pose_cb, 10)
        self.create_subscription(Log, '/rosout', self.rosout_cb, 10)

    def pose_cb(self, msg):
        robot_data["x"] = msg.x
        robot_data["y"] = msg.y
        robot_data["theta"] = math.degrees(msg.theta) % 360
        robot_data["linear_v"] = msg.linear_velocity
        robot_data["angular_v"] = msg.angular_velocity

    def rosout_cb(self, msg):
        level = "Info"
        if msg.level >= 40: level = "Error"
        elif msg.level >= 30: level = "Warning"
        
        rosout_logs.insert(0, {
            "id": int(time.time() * 1000),
            "module": msg.name,
            "description": msg.msg,
            "time": time.strftime("%Y-%m-%dT%H:%M:%S")
        })
        if len(rosout_logs) > 50: rosout_logs.pop()

def generate_blank_map():
    img = Image.new('RGBA', (800, 800), (245, 245, 245, 255))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')

cached_map = generate_blank_map()

@app.route('/api/v2.0.0/status', methods=['GET', 'PUT'])
def status():
    return jsonify({
        "state_id": 3,
        "state_text": "Ready",
        "battery_percentage": 95.0,
        "map_id": "turtlesim_map",
        "position": {"x": robot_data["x"], "y": robot_data["y"], "orientation": robot_data["theta"]},
        "velocity": {"linear": robot_data["linear_v"], "angular": robot_data["angular_v"]},
        "errors": []
    })

@app.route('/api/v2.0.0/maps/<map_id>', methods=['GET'])
def map_detail(map_id):
    return jsonify({"resolution": 0.01375, "origin_x": 0.0, "origin_y": 0.0, "base_map": cached_map})

@app.route('/api/v2.0.0/maps/<map_id>/positions', methods=['GET'])
def positions(map_id):
    return jsonify(waypoints)

@app.route('/api/v2.0.0/missions', methods=['GET'])
def get_missions():
    return jsonify([{"guid": f"mission-{i}", "name": f"Mission {i}"} for i in range(1, 4)])

@app.route('/api/v2.0.0/mission_queue', methods=['GET', 'POST', 'DELETE'])
def m_queue():
    global mission_queue
    if request.method == 'DELETE':
        mission_queue = []
        return "", 204
    if request.method == 'POST':
        mission_queue.append({"id": len(mission_queue) + 1, "state": "Executing", "mission_id": request.json.get("mission_id")})
        return jsonify({"id": len(mission_queue)}), 201
    return jsonify(mission_queue)

@app.route('/api/v2.0.0/mission_queue/<int:mq_id>', methods=['GET'])
def mq_detail(mq_id):
    for m in mission_queue:
        if m["id"] == mq_id: return jsonify(m)
    return jsonify({}), 404

@app.route('/api/v2.0.0/log/sys_log', methods=['GET'])
def sys_log():
    return jsonify(rosout_logs[:10])

@app.route('/api/v2.0.0/log/error_reports', methods=['GET'])
def error_reports():
    return jsonify([])

@app.route('/api/v2.0.0/experimental/diagnostics', methods=['GET'])
def diagnostics():
    return jsonify([])

@app.route('/api/v2.0.0/system/protective_scan', methods=['GET'])
def protective_scan():
    img = Image.new('RGBA', (200, 200), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png')

def run_ros():
    rclpy.init()
    node = MirBridgeNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    threading.Thread(target=run_ros, daemon=True).start()
    app.run(host='0.0.0.0', port=8080, debug=False)