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

rem Folders synced by OneDrive or unzipped from an archive can carry the Windows ReadOnly
rem flag, which makes PHP report Laravel's cache folders as unwritable.
attrib -R "%APP%\bootstrap\cache" /S /D >nul 2>nul
attrib -R "%APP%\storage" /S /D >nul 2>nul

if not exist "%APP%\vendor\autoload.php" (
    echo Installing the Laravel dependencies for the first time...
    pushd "%APP%"
    call composer install --no-interaction
    popd
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
echo Computing the forecasts and hotspots...
call php artisan mandasafe:warm
popd

rem OPcache keeps Laravel compiled in memory between requests. XAMPP ships it switched off,
rem and without it every request re-reads and recompiles the whole framework.
set "PHPOPTS="
php -m 2>nul | findstr /i /c:"Zend OPcache" >nul
if not errorlevel 1 (
    set "PHPOPTS=-d opcache.enable=1 -d opcache.enable_cli=1"
) else (
    php -d zend_extension=opcache -m 2>nul | findstr /i /c:"Zend OPcache" >nul
    if not errorlevel 1 set "PHPOPTS=-d zend_extension=opcache -d opcache.enable=1 -d opcache.enable_cli=1"
)

rem The same server "php artisan serve" starts, with OPcache on. laravel\server.php sends the
rem pages and assets straight from disk and passes only /api/... calls to Laravel.
echo Starting MandaSafe (Laravel)...
start "MandaSafe Server" /min cmd /c "cd /d ""%APP%\public"" && php %PHPOPTS% -S 127.0.0.1:%PORT% ..\server.php"

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
