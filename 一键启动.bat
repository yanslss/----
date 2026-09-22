@echo off
chcp 936 >nul
title 本地爬虫工作台 - 一键启动
setlocal

set "ROOT=%~dp0"
set "ROOTDIR=%ROOT:~0,-1%"
set "PROJECT=%ROOTDIR%\project"

echo ============================================
echo   本地爬虫工作台 - 一键启动
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 goto no_node

if not exist "%PROJECT%\package.json" goto no_project

cd /d "%PROJECT%"

if not exist "node_modules" (
    echo [1/3] 首次运行，正在安装依赖，需要联网，请耐心等待...
    call npm install
    if errorlevel 1 goto install_fail
    echo.
)

if not exist "node_modules\playwright-core\.local-browsers" (
    echo [2/3] 正在下载浏览器内核，首次需要几分钟...
    call npm run install:browser
    if errorlevel 1 goto browser_fail
    echo.
)

findstr /c:"REPLACE_ME" ".env" >nul 2>nul
if not errorlevel 1 (
    echo [提示] .env 里的 DEEPSEEK_API_KEY 还没有填写，
    echo        没有密钥时 AI 规划与校验会失败，请先去填写。
    echo.
)

echo [3/3] 正在编译并启动，请稍候...
echo.
call npm start

echo.
echo 程序已退出。
pause
exit /b 0

:no_node
echo [错误] 没有检测到 Node.js / npm。
echo        请先安装 Node.js（建议 18 以上版本）：https://nodejs.org/
echo.
pause
exit /b 1

:no_project
echo [错误] 没有找到 "%PROJECT%\package.json"
echo        请确认本文件与 project 文件夹放在同一目录下。
echo.
pause
exit /b 1

:install_fail
echo.
echo [错误] 依赖安装失败，请检查网络后重试。
pause
exit /b 1

:browser_fail
echo.
echo [错误] 浏览器内核下载失败，请检查网络后重试。
pause
exit /b 1
