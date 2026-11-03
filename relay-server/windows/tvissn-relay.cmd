@echo off
rem Runs tvissn-relay.ps1 without changing the execution policy. No arguments opens the menu.
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tvissn-relay.ps1" %*
if errorlevel 1 pause
