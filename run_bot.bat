@echo off
chcp 65001 > nul
title Bot Telegram Check Live/Die MXH (FB - TikTok - Instagram)

:LOOP
echo ==============================================================================
echo [START] Đang khởi động Bot Telegram Check MXH... (%date% %time%)
echo ==============================================================================
python bot.py
echo.
echo ⚠️ Bot vừa dừng lại. Tự động phục hồi và chạy lại sau 3 giây... (Nhấn Ctrl+C để thoát hẳn)
timeout /t 3 > nul
goto LOOP
