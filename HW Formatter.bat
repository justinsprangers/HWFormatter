@echo off
rem Double-click to open HW Formatter, or drag a homework PDF onto this file.
python "%~dp0hwformat.py" %*
if errorlevel 1 pause
