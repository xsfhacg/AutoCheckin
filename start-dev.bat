@echo off
setlocal

cd /d "%~dp0"

echo Auto Checkin starting...
echo.

if not exist "node_modules" (
  echo Dependencies not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Launching hot reload dev server...
echo Frontend: http://localhost:3333
echo Backend:  http://localhost:8787
echo.

call npm run dev

echo.
echo Server stopped.
pause
