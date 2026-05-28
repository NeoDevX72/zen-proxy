@echo off
title ZenProxy
:loop
"%~dp0ZenProxy.exe"
if %errorlevel% == 42 (
    ping 127.0.0.1 -n 3 > nul
    goto loop
)
