@echo off
setlocal
REM This private shim is on PATH only in wmux terminals with native Codex.
"%WMUX_CODEX_RUNTIME%" "%WMUX_CODEX_LAUNCHER%" %*
exit /b %ERRORLEVEL%
