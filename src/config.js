module.exports = {
    mir: {
        defaultHost: "192.168.12.20",
        id: "distributor",
        pw: "distributor",
        pollIntervalMs: 1500
    },
    ur: {
        controlTopic: "/joint_trajectory_controller/joint_trajectory",          // Float32MultiArray
        scenarioTopic: "/scenario_trigger",    // Float32
        logTopic: "/ur_rosout",            // rcl_interfaces/msg/Log
        manualModeTopic: "/ur_manual_mode",       // std_msgs/msg/Bool
        lockTopic: "/ur_lock",                    // std_msgs/msg/Bool (Consolidated Lock/E-Stop)
        freedriveTopic: "/ur_freedrive",          // std_msgs/msg/Bool
        statusTopic: "/ur_status",                // std_msgs/msg/String (NEW)
        jointTopic: "/joint_states",              // sensor_msgs/msg/JointState
        rosoutTopic: "/rosout",                   // rcl_interfaces/msg/Log
        cameraTopic: "/camera/color/image_raw/compressed", // Standard compressed topic

        scenarios: [
            { id: 1, topic: "/scenario_1", label: "Scen 1" },
            { id: 2, topic: "/scenario_2", label: "Scen 2" },
            { id: 3, topic: "/scenario_3", label: "Scen 3" }
        ],
        mirPlayTopic: "/mir_cmd_play",             // std_msgs/msg/Bool (NEW)
        mirAddTopic: "/mir_cmd_add",               // std_msgs/msg/Bool (NEW)
        mirClearTopic: "/mir_cmd_clear"            // std_msgs/msg/Bool (NEW)
    }
};
