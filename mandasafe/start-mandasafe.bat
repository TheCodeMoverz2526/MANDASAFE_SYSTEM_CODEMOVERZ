@echo off
setlocal enabledelayedexpansion
title MandaSafe
cd /d "%~dp0"

set "PORT=5500"
set "APP=%~dp0laravel"
set "LOG=%APP%\storage\logs\server.log"

echo.
echo  ==========================================
echo   MandaSafe - starting
echo  ==========================================
echo.

REM ---------------------------------------------------------------- PHP
where php >nul 2>nul
if errorlevel 1 goto no_php

REM --------------------------------------------------- already running?
curl -s -o nul --max-time 3 "http://localhost:%PORT%/api/otp-status" >nul 2>nul
if not errorlevel 1 (
    echo  MandaSafe is already running on port %PORT%.
    start "" "http://localhost:%PORT%/"
    goto ready
)

REM ----------------------------------------------------- dependencies
if not exist "%APP%\vendor\autoload.php" (
    where composer >nul 2>nul
    if errorlevel 1 goto no_composer
    echo  Installing the PHP dependencies. First run only - this takes a few minutes.
    echo.
    pushd "%APP%"
    call composer install --no-interaction
    set "RC=!errorlevel!"
    popd
    if not "!RC!"=="0" goto composer_failed
)

REM ----------------------------------------------- Python (ML backend)
python -c "import sys" >nul 2>nul
if not %errorlevel%==0 (
    echo.
    echo MandaSafe's road-safety predictions need Python 3.9+ on your PATH.
    echo Install it from https://www.python.org/downloads/ ^(check "Add python.exe to PATH"^),
    echo then run this file again.
    pause
    exit /b 1
)

python -c "import numpy, scipy, sklearn" >nul 2>nul
if not %errorlevel%==0 (
    echo Installing the Python ML dependencies for the first time...
    python -m pip install --quiet -r "%~dp0mlequirements.txt"
)

REM ------------------------------------------------------------- .env
if not exist "%APP%\.env" (
    echo  Creating the environment file...
    copy "%APP%\.env.example" "%APP%\.env" >nul
    pushd "%APP%"
    call php artisan key:generate --no-interaction
    popd
)

findstr /b /c:"APP_KEY=base64:" "%APP%\.env" >nul 2>nul
if errorlevel 1 (
    echo  Generating the application key...
    pushd "%APP%"
    call php artisan key:generate --no-interaction --force
    popd
)

REM --------------------------------------------------------- database
if not exist "%APP%\database\database.sqlite" (
    findstr /b /c:"DB_CONNECTION=sqlite" "%APP%\.env" >nul 2>nul
    if not errorlevel 1 (
        echo  Creating the database file...
        type nul > "%APP%\database\database.sqlite"
    )
)

echo  Preparing the MandaSafe database...
pushd "%APP%"
call php artisan migrate --force --no-interaction
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" goto migrate_failed

pushd "%APP%"
call php artisan db:seed --force --no-interaction
popd

REM ----------------------------------------------------------- serve
echo  Starting the MandaSafe server...
if exist "%LOG%" del "%LOG%" >nul 2>nul
start "MandaSafe Server" /min cmd /c "cd /d "%APP%" && php artisan serve --port=%PORT% > "%LOG%" 2>&1"

REM Wait for it to answer before opening the browser, so a failure is reported here
REM rather than as a blank page.
set "READY="
for /l %%i in (1,1,20) do (
    if not defined READY (
        curl -s -o nul --max-time 2 "http://localhost:%PORT%/" >nul 2>nul
        if not errorlevel 1 (
            set "READY=1"
        ) else (
            ping -n 2 127.0.0.1 >nul
        )
    )
)
if not defined READY goto server_failed

start "" "http://localhost:%PORT%/"

:ready
echo.
echo  MandaSafe is running:
echo    Residents / public : http://localhost:%PORT%/
echo    Sign in            : http://localhost:%PORT%/login.html
echo    Admin console      : http://localhost:%PORT%/Mandasafe.html
echo.
echo  Leave the minimised "MandaSafe Server" window open while using MandaSafe.
echo  Closing it stops MandaSafe.
echo.
pause
exit /b 0

REM ------------------------------------------------------------ errors
:no_php
echo.
echo  MandaSafe cannot start: PHP was not found.
echo.
echo  Install XAMPP from https://www.apachefriends.org/ then add its PHP folder
echo  (usually C:\xampp\php) to your PATH, open a NEW window and run this file again.
echo.
pause
exit /b 1

:no_composer
echo.
echo  MandaSafe cannot start: Composer was not found, and the PHP dependencies
echo  are not installed yet.
echo.
echo  Install Composer from https://getcomposer.org/Composer-Setup.exe , open a NEW
echo  window and run this file again.
echo.
pause
exit /b 1

:composer_failed
echo.
echo  "composer install" did not finish. The message above says why - it is usually
echo  no internet connection, or a PHP extension that is switched off in php.ini
echo  (MandaSafe needs pdo_sqlite, mbstring, openssl, fileinfo and zip).
echo.
pause
exit /b 1

:migrate_failed
echo.
echo  The database could not be prepared. The message above says why.
echo.
echo  Most often the SQLite file is missing or read-only:
echo    %APP%\database\database.sqlite
echo  If MandaSafe is set to MySQL in laravel\.env, make sure MySQL is running.
echo.
pause
exit /b 1

:server_failed
echo.
echo  The server did not start. What it printed:
echo.
if exist "%LOG%" (type "%LOG%") else (echo  [no output was captured])
echo.
echo  If it says the address is already in use, something else is on port %PORT%.
echo  Close it, or change PORT at the top of this file.
echo.
pause
exit /b 1
