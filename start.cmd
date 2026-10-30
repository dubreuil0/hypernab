@echo off
cd /d "%~dp0"
node src/server.js --open
if errorlevel 1 pause
