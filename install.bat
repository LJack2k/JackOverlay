@echo off
echo Installing Webcam Overlay dependencies...
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
echo.
echo Done! Run start.bat to launch the app.
pause
