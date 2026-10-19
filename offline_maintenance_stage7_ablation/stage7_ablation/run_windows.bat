@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto no_node
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto failed
node run_all.cjs
if errorlevel 1 goto failed
powershell -NoProfile -Command "Compress-Archive -LiteralPath 'stage7_results' -DestinationPath 'stage7_results.zip' -Force"
if errorlevel 1 goto failed
echo.
echo SUCCESS: Upload stage7_results.zip
pause
exit /b 0
:no_node
echo Install Node.js 24.15.0 or newer 24.x first.
:failed
echo Run failed. Keep the console output and results for diagnosis.
pause
exit /b 1
