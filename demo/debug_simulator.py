import rclpy
from rclpy.node import Node
import time
import math
import io
from PIL import Image, ImageDraw

# ROS 2 Messages
from std_msgs.msg import Bool, String, Float32
from std_msgs.msg import Float32MultiArray
from sensor_msgs.msg import JointState, CompressedImage

class UIDebugSimulator(Node):
    def __init__(self):
        super().__init__('ui_debug_simulator')

        # --- [1] UR 내부 상태 변수 ---
        self.ur_state = "LOCKED"
        self.start_time = time.time()

        self.get_logger().info("==================================================")
        self.get_logger().info("🚀 UI 종합 디버깅 시뮬레이터 노드가 시작되었습니다!")
        self.get_logger().info("==================================================")

        # ==========================================
        # [2] SUBSCRIBERS: UI -> ROS2 (명령어 감청 및 출력)
        # ==========================================
        
        # MiR Commands
        self.create_subscription(Bool, '/mir_cmd_play', self.mir_play_cb, 10)
        self.create_subscription(Bool, '/mir_cmd_add', self.mir_add_cb, 10)
        self.create_subscription(Bool, '/mir_cmd_clear', self.mir_clear_cb, 10)

        # UR Commands
        self.create_subscription(Bool, '/ur_lock', self.ur_lock_cb, 10)
        self.create_subscription(Bool, '/ur_freedrive', self.ur_freedrive_cb, 10)
        self.create_subscription(Bool, '/ur_manual_mode', self.ur_manual_mode_cb, 10)
        self.create_subscription(Bool, '/ur_initial_pose', self.ur_initial_pose_cb, 10)
        self.create_subscription(Float32, '/scenario_trigger', self.ur_scenario_cb, 10)
        self.create_subscription(Float32MultiArray, '/joint_trajectory_controller/joint_trajectory', self.ur_control_cb, 10)

        # ==========================================
        # [3] PUBLISHERS: ROS2 -> UI (가짜 데이터 전송)
        # ==========================================
        self.status_pub = self.create_publisher(String, '/ur_status', 10)
        self.joint_pub = self.create_publisher(JointState, '/joint_states', 10)
        self.cam_pub = self.create_publisher(CompressedImage, '/camera/color/image_raw/compressed', 10)

        # 10Hz (0.1초) 주기로 데이터 퍼블리시
        self.timer = self.create_timer(0.1, self.timer_publish_callback)


    # --- MiR Callback Functions ---
    def mir_play_cb(self, msg):
        cmd = "PLAY" if msg.data else "PAUSE"
        self.get_logger().info(f"[MiR 수신] Play/Pause 토픽: {cmd} ({msg.data})")

    def mir_add_cb(self, msg):
        self.get_logger().info(f"[MiR 수신] Add Mission 토픽: {msg.data}")

    def mir_clear_cb(self, msg):
        self.get_logger().info(f"[MiR 수신] Clear Mission 토픽: {msg.data}")


    # --- UR Callback Functions ---
    def ur_lock_cb(self, msg):
        self.ur_state = "LOCKED" if msg.data else "UNLOCKED"
        self.get_logger().info(f"[UR 수신] Lock 토픽: {msg.data} -> 상태 변경: {self.ur_state}")

    def ur_freedrive_cb(self, msg):
        if msg.data:
            self.ur_state = "FREEDRIVE"
        else:
            self.ur_state = "UNLOCKED"
        self.get_logger().info(f"[UR 수신] Freedrive 토픽: {msg.data} -> 상태 변경: {self.ur_state}")

    def ur_manual_mode_cb(self, msg):
        self.get_logger().info(f"[UR 수신] Manual Mode 토픽: {msg.data}")

    def ur_initial_pose_cb(self, msg):
        self.get_logger().info(f"[UR 수신] Initial Pose 토픽: {msg.data}")

    def ur_scenario_cb(self, msg):
        self.get_logger().info(f"[UR 수신] Scenario Trigger 토픽: ID {msg.data}")

    def ur_control_cb(self, msg):
        self.get_logger().info(f"[UR 수신] Manual Control 토픽: {list(msg.data)}")


    # --- Timer Publish Function ---
    def timer_publish_callback(self):
        t = time.time() - self.start_time

        # 1. UR 상태 토픽 발행
        status_msg = String()
        status_msg.data = self.ur_state
        self.status_pub.publish(status_msg)

        # 2. 가짜 Joint State 발행 (3D Viewer 애니메이션용)
        js = JointState()
        js.header.stamp = self.get_clock().now().to_msg()
        js.name = ["shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", 
                   "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"]
        # 시간에 따라 부드럽게 움직이도록 사인/코사인 함수 사용
        js.position = [
            math.sin(t * 0.5) * 1.0, 
            -1.5, 
            1.0 + math.sin(t) * 0.2, 
            -1.5, 
            -1.57, 
            math.cos(t * 2.0) * 1.0
        ]
        self.joint_pub.publish(js)

        # 3. 가짜 압축 이미지(Camera) 발행 (파란 점이 둥둥 떠다니는 이미지)
        img = Image.new('RGB', (320, 240), color=(40, 44, 52))
        draw = ImageDraw.Draw(img)
        x = 160 + int(50 * math.sin(t * 2))
        y = 120 + int(50 * math.cos(t * 2))
        draw.ellipse((x-20, y-20, x+20, y+20), fill=(0, 165, 229))
        
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        
        cam_msg = CompressedImage()
        cam_msg.format = "jpeg"
        cam_msg.data = buf.getvalue()
        self.cam_pub.publish(cam_msg)


def main(args=None):
    rclpy.init(args=args)
    node = UIDebugSimulator()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        node.get_logger().info("시뮬레이터 종료 중...")
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()