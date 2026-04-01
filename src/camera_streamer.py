import rclpy
from rclpy.node import Node
from sensor_msgs.msg import CompressedImage
import base64
import sys

class CameraStreamer(Node):
    def __init__(self, topic):
        super().__init__('camera_streamer_node')
        self.subscription = self.create_subscription(
            CompressedImage,
            topic,
            self.listener_callback,
            10)
        self.subscription

    def listener_callback(self, msg):
        # msg.data is already jpeg bytes for CompressedImage
        b64_data = base64.b64encode(msg.data).decode('utf-8')
        sys.stdout.write(b64_data + '\n')
        sys.stdout.flush()

def main(args=None):
    rclpy.init(args=args)
    topic = sys.argv[1] if len(sys.argv) > 1 else '/camera/image_raw/compressed'
    streamer = CameraStreamer(topic)
    try:
        rclpy.spin(streamer)
    except KeyboardInterrupt:
        pass
    streamer.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    main()
