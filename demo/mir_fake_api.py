import requests
import hashlib
import base64
import time
import json

# ==========================================
# 1. 설정 (로봇의 실제 IP와 계정 정보로 확인 후 수정하세요)
# ==========================================
ROBOT_IP = "192.168.12.20"
USERNAME = "distributor"
PASSWORD = "distributor"

# ==========================================
# 2. MiR API 인증 토큰 생성
# ==========================================
# MiR API는 비밀번호를 SHA-256으로 해싱한 뒤, '아이디:해시'를 Base64로 인코딩해야 합니다.
pw_hash = hashlib.sha256(PASSWORD.encode('utf-8')).hexdigest()
auth_str = f"{USERNAME}:{pw_hash}"
auth_b64 = base64.b64encode(auth_str.encode('utf-8')).decode('utf-8')

HEADERS = {
    "Authorization": f"Basic {auth_b64}",
    "Content-Type": "application/json",
    "Accept-Language": "en_US"
}

# ==========================================
# 3. 미션 큐 확인 함수
# ==========================================
def check_mission_queue():
    url = f"http://{ROBOT_IP}/api/v2.0.0/mission_queue"
    try:
        response = requests.get(url, headers=HEADERS, timeout=5)
        if response.status_code == 200:
            queue_data = response.json()
            print(f"\n[{time.strftime('%H:%M:%S')}] 현재 미션 큐 상태 (총 {len(queue_data)}개):")
            
            if len(queue_data) == 0:
                print("  -> 큐가 비어 있습니다.")
                return

            for idx, mission in enumerate(queue_data):
                # 주요 상태와 ID만 파싱해서 출력
                m_id = mission.get('id', 'N/A')
                state = mission.get('state', 'N/A')
                
                # API 버전에 따라 mission_id 또는 mission(URL 형태)으로 올 수 있음
                guid = mission.get('mission_id', mission.get('mission', 'N/A'))
                
                print(f"  - [큐 ID: {m_id}] 상태(State): '{state}' | 미션 GUID: {guid}")
                
                # 첫 번째(가장 최근) 항목의 원본 데이터 상세 출력
                if idx == 0:
                    print("    [가장 최근 미션 원본 데이터 상세]")
                    print(f"    {json.dumps(mission, indent=4)}")
        else:
            print(f"[{time.strftime('%H:%M:%S')}] API 호출 실패: 상태 코드 {response.status_code}")
    except Exception as e:
        print(f"통신 에러 발생: {e}")

# ==========================================
# 4. 실시간 모니터링 실행
# ==========================================
if __name__ == "__main__":
    print(f"MiR 로봇({ROBOT_IP}) API 모니터링을 시작합니다... (종료: Ctrl+C)")
    try:
        while True:
            check_mission_queue()
            time.sleep(2)  # 2초마다 데이터 갱신
    except KeyboardInterrupt:
        print("\n모니터링을 종료합니다.")