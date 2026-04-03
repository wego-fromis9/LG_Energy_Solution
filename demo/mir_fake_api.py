import requests
import hashlib
import base64
import time

# 로봇 IP 설정
ROBOT_IP = "192.168.12.20"
USERNAME = "distributor"
PASSWORD = "distributor"

pw_hash = hashlib.sha256(PASSWORD.encode('utf-8')).hexdigest()
auth_b64 = base64.b64encode(f"{USERNAME}:{pw_hash}".encode('utf-8')).decode('utf-8')

HEADERS = {"Authorization": f"Basic {auth_b64}"}

print(f"[{time.strftime('%H:%M:%S')}] 라이다 맵 이미지(0~19) 다운로드 시작...")

for i in range(20):
    # 캐시를 무시하기 위한 타임스탬프
    timestamp = int(time.time() * 1000)
    url = f"http://{ROBOT_IP}/robot-images/laser_map/laser_map_{i}.png?t={timestamp}"
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=3)
        if response.status_code == 200:
            filename = f"laser_map_{i}.png"
            with open(filename, "wb") as f:
                f.write(response.content)
            print(f"✅ {filename} 다운로드 성공!")
        else:
            print(f"❌ {i}번 이미지 실패 (상태 코드: {response.status_code})")
    except Exception as e:
        print(f"⚠️ {i}번 이미지 통신 에러: {e}")

print("다운로드 완료! 폴더를 확인해 보세요.")