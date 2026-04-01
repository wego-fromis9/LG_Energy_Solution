import requests
import json
from datetime import datetime

# MiR 로봇 설정 (환경에 맞게 수정해주세요)
ROBOT_IP = "192.168.12.20"

# ⚠️ [매우 중요] 401 에러가 발생한다면 아래 AUTH_TOKEN을 반드시 수정해야 합니다.
# 수정 방법: 로봇 웹 인터페이스 접속 -> 우측 상단 메뉴 [Help] -> [API documentation] 
# -> 화면에 표시된 'Authorization: Basic ...' 값을 복사하여 아래에 붙여넣으세요.
AUTH_TOKEN = "Basic ZGlzdHJpYnV0b3I6NjJmMmYwZjFlZmYxMGQzMTUyYzk1ZjZmMDU5NjU3NmU0ODJiYjhlNDQ4MDY0MzNmNGNmOTI5NzkyODM0YjAxNA=="

HEADERS = {
    "Content-Type": "application/json",
    "Accept-Language": "en_US",
    "Authorization": AUTH_TOKEN
}

def print_401_troubleshooting():
    """
    401 Unauthorized 에러 발생 시 해결 가이드를 출력합니다.
    """
    print("❌ [실패] 상태 코드: 401 (Unauthorized) - 권한이 없습니다.")
    print("   👉 해결 방법: 코드의 AUTH_TOKEN 값이 실제 로봇의 키값과 일치하지 않습니다.")
    print("   👉 로봇 UI의 [Help] > [API documentation]에서 실제 Authorization 키값을 복사해 적용해주세요.")

def get_live_status():
    """
    GET /status API를 호출하여 현재 상태와 발생 중인 에러를 확인합니다.
    """
    url = f"http://{ROBOT_IP}/api/v2.0.0/status"
    print("\n--- [실시간 현재 상태 및 에러] ---")
    print(f"{'State':<12} | {'Source (Module)':<20} | {'Message':<40} | {'Time'}")
    print("-" * 100)
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code == 200:
            status = response.json()
            current_state = status.get("state_text", "Unknown")
            current_time = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            
            # 1. 현재 로봇 상태 출력
            mission_text = str(status.get('mission_text', 'Idle'))[:40]
            print(f"{current_state:<12} | {'System':<20} | {mission_text:<40} | {current_time}")
            
            # 2. 발생 중인 에러가 있다면 출력
            errors = status.get("errors", [])
            for error in errors:
                source = str(error.get("module", "Unknown"))[:20]
                message = str(error.get("description", "No description"))[:40]
                print(f"{'Active Error':<12} | {source:<20} | {message:<40} | {current_time}")
                
        elif response.status_code == 401:
            print_401_troubleshooting()
        else:
            print(f"상태를 불러오는데 실패했습니다. 상태 코드: {response.status_code}")
    except Exception as e:
        print(f"API 요청 중 오류 발생: {e}")

def get_error_logs():
    """
    GET /log/error_reports API를 호출하여 시스템 에러 로그(진단 리포트)를 가져옵니다.
    """
    url = f"http://{ROBOT_IP}/api/v2.0.0/log/error_reports"
    print("\n--- [시스템 에러 로그 (최신 5건)] ---")
    print(f"{'State':<12} | {'Source (Module)':<20} | {'Message':<40} | {'Time'}")
    print("-" * 100)
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code == 200:
            logs = response.json()
            if not logs:
                print("저장된 시스템 에러 로그가 없습니다.")
                
            # 요약 목록에서 최신 5건만 가져와서 개별 ID로 상세 정보 조회
            for summary in logs[-5:]:
                log_id = summary.get("id")
                detail_url = f"http://{ROBOT_IP}/api/v2.0.0/log/error_reports/{log_id}"
                detail_res = requests.get(detail_url, headers=HEADERS, timeout=5)
                
                if detail_res.status_code == 200:
                    log = detail_res.json()
                    state = "Error Log"
                    source = str(log.get("module", "Unknown"))[:20]
                    message = str(log.get("description", "No description"))[:40]
                    time = str(log.get("time", "Unknown time"))
                    
                    print(f"{state:<12} | {source:<20} | {message:<40} | {time}")
        elif response.status_code == 401:
            print_401_troubleshooting()
        else:
            print(f"로그를 불러오는데 실패했습니다. 상태 코드: {response.status_code}")
    except Exception as e:
        print(f"API 요청 중 오류 발생: {e}")

def get_mission_logs():
    """
    GET /mission_queue API를 호출하여 미션 진행 로그를 가져옵니다.
    """
    url = f"http://{ROBOT_IP}/api/v2.0.0/mission_queue"
    print("\n--- [미션 수행 로그 (최신 5건)] ---")
    print(f"{'State':<12} | {'Source (Mission ID)':<20} | {'Message':<40} | {'Time (Finished)'}")
    print("-" * 100)
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code == 200:
            missions = response.json()
            if not missions:
                print("수행된 미션 기록이 없습니다.")
                
            # 요약 목록에서 최신 5건만 가져와서 개별 ID로 상세 정보 조회
            for summary in missions[-5:]:
                m_id = summary.get("id")
                detail_url = f"http://{ROBOT_IP}/api/v2.0.0/mission_queue/{m_id}"
                detail_res = requests.get(detail_url, headers=HEADERS, timeout=5)
                
                if detail_res.status_code == 200:
                    mission = detail_res.json()
                    state = str(mission.get("state", "Unknown"))
                    source = str(mission.get("mission_id", "Unknown"))[:20] # ID가 길어 20자로 축약
                    message = str(mission.get("message", "No message"))[:40] # 메시지가 길 경우 축약
                    time = str(mission.get("finished", mission.get("started", "Not started")))
                    
                    print(f"{state:<12} | {source:<20} | {message:<40} | {time}")
        elif response.status_code == 401:
            print_401_troubleshooting()
        else:
            print(f"로그를 불러오는데 실패했습니다. 상태 코드: {response.status_code}")
    except Exception as e:
        print(f"API 요청 중 오류 발생: {e}")

if __name__ == "__main__":
    print("MiR 로봇 로그 추출을 시작합니다...\n")
    
    get_live_status()  # 현재 상태 및 발생중인 에러
    get_error_logs()   # 시스템 에러 로그 (과거 기록)
    get_mission_logs() # 미션 큐 기록