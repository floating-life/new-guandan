@echo off
chcp 65001 >nul
start "Guandan Trainer Local" /D "%~dp0" powershell.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0start-lan.ps1" %*
