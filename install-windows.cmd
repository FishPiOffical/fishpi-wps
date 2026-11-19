@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
if exist runtime\node.exe goto bundled

where node >nul 2>&1
if errorlevel 1 goto node_required
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)"
if errorlevel 1 goto node_required

if not exist package.json goto install
if exist node_modules\esbuild if exist node_modules\@xmldom\xmldom goto build
call npm ci
if errorlevel 1 goto failed

:build
call npm run build
if errorlevel 1 goto failed

:install
node dist\install.mjs %*
goto result

:bundled
runtime\node.exe dist\install.mjs %*

:result
if errorlevel 1 goto failed
popd
exit /b 0

:node_required
echo Install Node.js 22.16 or later and make sure node.exe is on PATH.

:failed
popd
if not defined CI pause
exit /b 1
