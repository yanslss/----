@echo off
chcp 936 >nul
title 本地爬虫工作台 - 一键打包
setlocal

set "ROOT=%~dp0"
set "ROOTDIR=%ROOT:~0,-1%"
set "PROJECT=%ROOTDIR%\project"
set "OUTDIR=%ROOTDIR%\打包输出"

echo ============================================
echo   本地爬虫工作台 - 一键打包（生成安装包 exe）
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 goto no_node

if not exist "%PROJECT%\package.json" goto no_project

cd /d "%PROJECT%"

if not exist "node_modules" (
    echo [1/4] 正在安装依赖，需要联网，请耐心等待...
    call npm install
    if errorlevel 1 goto install_fail
    echo.
)

if not exist "node_modules\playwright-core\.local-browsers" (
    echo [2/4] 正在下载浏览器内核，首次需要几分钟...
    call npm run install:browser
    if errorlevel 1 goto browser_fail
    echo.
)

findstr /c:"REPLACE_ME" ".env" >nul 2>nul
if not errorlevel 1 goto ask_key

goto do_build

:ask_key
echo [警告] .env 里的 DEEPSEEK_API_KEY 还是占位内容，
echo        打包出来的程序将无法调用 AI，建议先填写密钥再打包。
echo.
choice /c YN /m "仍要继续打包吗"
if errorlevel 2 goto cancelled
echo.

:do_build
echo [3/4] 正在编译并打包，首次打包需要几分钟，期间请勿关闭窗口...
echo.
call npm run dist
if errorlevel 1 goto build_fail

echo.
echo [4/4] 正在把安装包复制到 "%ROOTDIR%" ...
copy /y "%OUTDIR%\*.exe" "%ROOTDIR%" >nul
if errorlevel 1 goto copy_fail

echo.
echo --------------------------------------------
echo  打包完成！同级目录下已生成安装包：
dir /b "%ROOTDIR%\*.exe"
echo --------------------------------------------
echo.
echo  把这个 exe 拷到其他电脑双击安装即可使用，
echo  安装后桌面会有“本地爬虫工作台”快捷方式。
echo  说明：安装包内已内置浏览器内核，体积较大属正常现象。
echo.
pause
exit /b 0

:copy_fail
echo.
echo [警告] 复制失败，可以直接到 "%OUTDIR%" 目录里取安装包。
echo.
pause
exit /b 1

:cancelled
echo 已取消。请先填写 .env 中的密钥，再重新运行本脚本。
echo.
pause
exit /b 1

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

:build_fail
echo.
echo [错误] 打包失败，请查看上方日志。
pause
exit /b 1
