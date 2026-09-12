@echo off
setlocal
cd /d "%~dp0"
set "PORT=5500"
set "APP=%~dp0laravel"

where php >nul 2>nul
if not %errorlevel%==0 (
    echo.
    echo MandaSafe cannot start because PHP is not on your PATH.
    echo Install XAMPP ^(https://www.apachefriends.org/^) and add C:\xampp\php to PATH,
    echo then run this file again.
    pause
    exit /b 1
)

if not exist "%APP%\vendor\autoload.php" (
    echo Installing the Laravel dependencies for the first time...
    pushd "%APP%"
    call composer install --no-interaction
    popd
)

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
    python -m pip install --quiet -r "%~dp0ml\requirements.txt"
)

if not exist "%APP%\.env" (
    echo Creating the environment file...
    copy "%APP%\.env.example" "%APP%\.env" >nul
    pushd "%APP%"
    call php artisan key:generate
    popd
)

echo Preparing the MandaSafe database...
pushd "%APP%"
call php artisan migrate --force
call php artisan db:seed --force
popd

echo Starting MandaSafe (Laravel)...
start "MandaSafe Server" /min cmd /c "cd /d ""%APP%"" && php artisan serve --port=%PORT%"

timeout /t 3 /nobreak >nul
start "" "http://localhost:%PORT%/"
echo.
echo MandaSafe is running at http://localhost:%PORT%/
echo   Residents / public : http://localhost:%PORT%/
echo   Sign in            : http://localhost:%PORT%/login.html
echo   Admin console      : http://localhost:%PORT%/Mandasafe.html
echo.
echo Leave the server window open while using MandaSafe.
pause
