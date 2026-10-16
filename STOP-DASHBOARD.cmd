@echo off
pushd "%~dp0"
docker compose stop
popd
if errorlevel 1 pause
