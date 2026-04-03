import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState, CompressedImage
from std_msgs.msg import Bool
from rcl_interfaces.msg import Log
import time
import math
import io
from PIL import Image, ImageDraw

class URMockNode(Node):
    def __init__(self):
        super().__init__('ur_mock_node')
        self.joint_pub = self.create_publisher(JointState, '/joint_states', 10)
        self.cam_pub = self.create_publisher(CompressedImage, '/camera/color/image_raw/compressed', 10)
        self.estop_pub = self.create_publisher(Bool, '/ur_estop', 10)
        
        # /rosout을 구독하여 /ur_rosout으로 포워딩
        self.ur_log_pub = self.create_publisher(Log, '/ur_rosout', 10)
        self.create_subscription(Log, '/rosout', self.rosout_cb, 10)
        
        self.timer = self.create_timer(0.1, self.timer_cb)
        self.start_time = time.time()

    def rosout_cb(self, msg):
        # 받은 로그 메시지를 그대로 /ur_rosout으로 토스
        self.ur_log_pub.publish(msg)

    def timer_cb(self):
        t = time.time() - self.start_time
        
        js = JointState()
        js.header.stamp = self.get_clock().now().to_msg()
        js.name = ["shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"]
        js.position = [math.sin(t) * 1.0, -1.5, 1.0, -1.5, -1.57, math.cos(t) * 2.0]
        self.joint_pub.publish(js)

        estop_msg = Bool()
        estop_msg.data = False
        self.estop_pub.publish(estop_msg)
        
        img = Image.new('RGB', (320, 240), color=(40, 44, 52))
        draw = ImageDraw.Draw(img)
        x, y = 160 + int(50 * math.sin(t * 2)), 120 + int(50 * math.cos(t * 2))
        draw.ellipse((x-20, y-20, x+20, y+20), fill=(0, 165, 229))
        
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        cam_msg = CompressedImage()
        cam_msg.format = "jpeg"
        cam_msg.data = buf.getvalue()
        self.cam_pub.publish(cam_msg)

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