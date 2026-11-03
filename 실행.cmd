@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
title 군 급식 식자재 안전 지키미 (베타)

if not exist ".env" (
  echo [안내] .env 파일이 없습니다. .env.example 을 복사해 .env 로 만들고 인증키를 넣으세요.
  echo        인증키 없이도 켜지지만 자료를 받을 수 없습니다.
  echo.
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app\server.py
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python app\server.py
  goto end
)
echo [오류] Python이 설치되어 있지 않습니다. https://www.python.org 에서 Python 3.10 이상을 설치하세요.

:end
echo.
echo 프로그램이 꺼졌습니다.
pause
