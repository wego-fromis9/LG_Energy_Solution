import websocket
import json
import time

# MiR 로봇의 웹소켓 포트는 기본적으로 9090을 사용합니다.
MIR_IP = "192.168.12.20"
WS_URL = f"ws://{MIR_IP}:9090"

def on_message(ws, message):
    # 로봇이 실시간으로 뿜어내는 데이터를 받아서 파싱합니다.
    data = json.loads(message)
    if 'msg' in data:
        log_msg = data['msg']
        
        # ROS 로그 레벨 구분 (1:DEBUG, 2:INFO, 4:WARN, 8:ERROR, 16:FATAL)
        level_num = log_msg.get('level', 2)
        level_str = "INFO"
        if level_num == 4: level_str = "WARN"
        elif level_num >= 8: level_str = "ERROR"

        # 로그 출력
        print(f"[{level_str}] 모듈: {log_msg.get('name', 'N/A')} | 메시지: {log_msg.get('msg', 'N/A')}")

def on_error(ws, error):
    print(f"❌ 웹소켓 에러: {error}")

def on_close(ws, close_status_code, close_msg):
    print("🔌 웹소켓 연결이 종료되었습니다.")

def on_open(ws):
    print(f"✅ MiR 로봇({MIR_IP}:9090) ROSbridge 연결 성공!")
    print("📡 실시간 시스템 로그(/rosout) 구독을 시작합니다...\n" + "="*50)
    
    # 로봇의 전체 시스템 로그(/rosout) 토픽을 구독(Subscribe)하겠다는 명령을 보냅니다.
    subscribe_msg = {
        "op": "subscribe",
        "topic": "/rosout",
        "type": "rosgraph_msgs/Log"
    }
    ws.send(json.dumps(subscribe_msg))

if __name__ == "__main__":
    print(f"[{time.strftime('%H:%M:%S')}] 로봇 내부 신경망 접속 시도 중...")
    
    # 웹소켓 앱 실행
    wsapp = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    
    # 무한 루프하며 로그 수신
    wsapp.run_forever()