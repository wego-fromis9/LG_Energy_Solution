import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState, CompressedImage
from rcl_interfaces.msg import Log
from std_msgs.msg import Float32, Bool
import time
import math
import io
from PIL import Image, ImageDraw

class URMockNode(Node):
    def __init__(self):
        super().__init__('ur_mock_node')
        
        # --- Publishers (대시보드로 데이터 전송) ---
        # 1. 3D 로봇 관절 상태
        self.joint_pub = self.create_publisher(JointState, '/joint_states', 10)
        # 2. 카메라 이미지
        self.cam_pub = self.create_publisher(CompressedImage, '/camera/color/image_raw/compressed', 10)
        # 3. 시스템 로그
        self.log_pub = self.create_publisher(Log, '/ur_rosout', 10)
        
        # --- Subscribers (대시보드에서 보낸 명령 수신) ---
        self.create_subscription(Float32, '/scenario_trigger', self.scenario_cb, 10)
        self.create_subscription(Bool, '/ur_manual_mode', self.manual_cb, 10)
        self.create_subscription(Bool, '/ur_unlock', self.unlock_cb, 10)
        self.create_subscription(Bool, '/ur_estop', self.estop_cb, 10)
        
        # --- Timers ---
        self.timer_10hz = self.create_timer(0.1, self.timer_10hz_cb)  # 10Hz (0.1초)
        self.timer_log = self.create_timer(3.0, self.timer_log_cb)    # 3초마다
        
        self.start_time = time.time()
        self.get_logger().info("🤖 UR 가상 데이터 퍼블리셔(ROS 2 Node)가 시작되었습니다!")
        self.get_logger().info("👉 rosbridge_server를 통해 대시보드와 통신합니다.")

    def scenario_cb(self, msg):
        self.get_logger().info(f"🎯 [명령 수신] 시나리오 트리거: {msg.data}")

    def manual_cb(self, msg):
        self.get_logger().info(f"🎯 [명령 수신] 매뉴얼 모드: {msg.data}")

    def unlock_cb(self, msg):
        self.get_logger().info(f"🎯 [명령 수신] 언락(Unlock): {msg.data}")

    def estop_cb(self, msg):
        self.get_logger().info(f"🎯 [명령 수신] E-Stop 비상정지: {msg.data}")

    def timer_10hz_cb(self):
        t = time.time() - self.start_time
        
        # 1. Joint States 생성 및 퍼블리시
        js = JointState()
        js.header.stamp = self.get_clock().now().to_msg()
        js.header.frame_id = "base_link"
        js.name = [
            "shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint",
            "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"
        ]
        js.position = [
            math.sin(t) * 1.0,
            -1.5 + math.sin(t * 0.8),
            1.0 + math.cos(t * 1.2),
            -1.5 + math.sin(t),
            -1.57,
            math.cos(t) * 2.0
        ]
        self.joint_pub.publish(js)
        
        # 2. Camera Image 생성 및 퍼블리시
        img = Image.new('RGB', (320, 240), color=(40, 44, 52))
        draw = ImageDraw.Draw(img)
        
        x = 160 + int(100 * math.sin(t))
        y = 120 + int(80 * math.cos(t * 1.5))
        draw.ellipse((x-20, y-20, x+20, y+20), fill=(0, 165, 229))
        
        time_str = time.strftime('%H:%M:%S')
        draw.text((10, 10), f"Mock UR Camera Live - {time_str}", fill=(255, 255, 255))
        
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        
        cam_msg = CompressedImage()
        cam_msg.header.stamp = self.get_clock().now().to_msg()
        cam_msg.format = "jpeg"
        cam_msg.data = buf.getvalue()
        self.cam_pub.publish(cam_msg)

    def timer_log_cb(self):
        # 3. Log Message 퍼블리시
        log_msg = Log()
        log_msg.level = 20 # INFO
        log_msg.name = "ur_robot"
        log_msg.msg = "[UR log] State: RUNNING (Mock Data via ROS 2)"
        self.log_pub.publish(log_msg)

def main(args=None):
    rclpy.init(args=args)
    node = URMockNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()