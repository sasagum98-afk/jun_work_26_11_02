"""Vercel 함수 입구: /api/* 요청을 PC판과 같은 Handler(app/server.py)로 처리.

환경 변수(Vercel 프로젝트 설정 > Environment Variables에 사용자가 직접 넣음)
- FOODSAFETY_KEY: 식품안전나라 인증키
- DATABASE_URL: Supabase Transaction pooler 주소 (postgresql://...:6543/postgres)
"""
import os
import sys
import time

# 서버 시계는 UTC → 기록 시각을 한국 시간으로 (한국은 서머타임 없음)
os.environ["TZ"] = "KST-9"
time.tzset()

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app"))
import server  # noqa: E402

server.Handler.app = server.App()


class handler(server.Handler):
    pass
