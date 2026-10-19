@echo off
chcp 65001 > nul
title Bot Messenger Quản Lý Nhóm

echo ======================================================
echo          HE THONG BOT MESSENGER FACEBOOK
echo ======================================================

cd /d "%~dp0"

if not exist "appstate.json" (
    echo [CANH BAO] Chua tim thay file 'appstate.json'!
    echo.
    echo Huong dan nhanh de chay bot:
    echo 1. Dung tien ich trinh duyet (nhu 'C3C FBState' hoac 'EditThisCookie')
    echo    de xuat Cookie cua tai khoan Facebook lam Bot thanh dang JSON.
    echo 2. Tao file co ten la 'appstate.json' ngay trong thu muc nay:
    echo    %~dp0appstate.json
    echo 3. Dan toan bo doan ma cookie JSON vao va luu lai.
    echo 4. Chay lai file nay!
    echo ======================================================
    echo.
    pause
    exit /b
)

echo [OK] Da tim thay appstate.json. Dang khoi chay bot...
echo.
npm start
pause
