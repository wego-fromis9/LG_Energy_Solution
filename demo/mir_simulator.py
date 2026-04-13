import json
import time
try:
    import websocket
except ImportError:
    print("라이브러리 설치가 필요합니다: pip3 install websocket-client")
    exit()

MIR_IP = "192.168.12.20"

def on_message(ws, message):
    data = json.loads(message)
    msg_data = data.get('msg', {})
    
    # ROS /diagnostics 토픽은 내부에 'status' 배열을 가집니다.
    if 'status' in msg_data:
        print("\n========== [빙고!] Hardware Health (Diagnostics) 데이터 수신 ==========\n")
        # 데이터가 너무 길 수 있으므로 예쁘게 출력
        print(json.dumps(msg_data, indent=2, ensure_ascii=False))
        # 데이터 구조만 파악하면 되므로 첫 번째 메시지만 받고 연결을 끊습니다.
        ws.close()

def on_open(ws):
    print(f"[{MIR_IP}:9090] 웹소켓 연결 성공!")
    print("/diagnostics 및 /diagnostics_agg 토픽 도청 중...")
    
    # 2가지 유력한 진단 토픽 모두 구독 요청
    req1 = {"op": "subscribe", "topic": "/diagnostics"}
    req2 = {"op": "subscribe", "topic": "/diagnostics_agg"}
    
    ws.send(json.dumps(req1))
    ws.send(json.dumps(req2))

def on_error(ws, error):
    print(f"Error: {error}")

if __name__ == "__main__":
    ws_url = f"ws://{MIR_IP}:9090"
    ws = websocket.WebSocketApp(ws_url, on_open=on_open, on_message=on_message, on_error=on_error)
    ws.run_forever()