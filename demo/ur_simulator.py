import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool, String
import time
import math

class URSimulator(Node):
    def __init__(self):
        super().__init__('ur_simulator')
        self.joint_pub = self.create_publisher(JointState, '/joint_states', 10)
        self.status_pub = self.create_publisher(String, '/ur_status', 10)
        
        # Listen to control commands
        self.lock_sub = self.create_subscription(Bool, '/ur_lock', self.lock_cb, 10)
        self.freedrive_sub = self.create_subscription(Bool, '/ur_freedrive', self.freedrive_cb, 10)
        
        # Internal State: LOCKED, UNLOCKED, FREEDRIVE
        self.state = "LOCKED"
        self.timer = self.create_timer(0.1, self.timer_cb)
        self.start_time = time.time()

    def lock_cb(self, msg):
        # True -> LOCKED, False -> UNLOCKED
        if msg.data:
            self.state = "LOCKED"
        else:
            self.state = "UNLOCKED"
        self.get_logger().info(f"Lock command received. State: {self.state}")

    def freedrive_cb(self, msg):
        # True -> FREEDRIVE, False -> revert to UNLOCKED
        if msg.data:
            self.state = "FREEDRIVE"
        else:
            self.state = "UNLOCKED"
        self.get_logger().info(f"Freedrive command received. State: {self.state}")

    def timer_cb(self):
        t = time.time() - self.start_time
        
        # 1. Publish Current State (10Hz)
        status_msg = String()
        status_msg.data = self.state
        self.status_pub.publish(status_msg)
        
        # 2. Publish Joint States (10Hz)
        js = JointState()
        js.header.stamp = self.get_clock().now().to_msg()
        js.name = [
            "shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", 
            "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"
        ]
        
        # Wrist 3 rotating continuously using time
        # Keep other joints slightly moving or static
        js.position = [
            0.0,
            -1.57,
            1.57,
            -1.57,
            -1.57,
            (t * 1.5) % (2 * math.pi) # continuous rotation
        ]
        self.joint_pub.publish(js)

def main(args=None):
    rclpy.init(args=args)
    node = URSimulator()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
