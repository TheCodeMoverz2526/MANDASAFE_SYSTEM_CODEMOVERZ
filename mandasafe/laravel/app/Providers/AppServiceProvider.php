<?php

namespace App\Providers;

use Illuminate\Foundation\Console\ServeCommand;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // `php artisan serve` starts PHP with only a short allow-list of environment variables,
        // which drops the PHP_INI_SCAN_DIR that start-mandasafe.bat sets to switch on OPcache
        // (php.d/mandasafe-opcache.ini). Without it every request, static files included,
        // recompiles Laravel from disk: about 2 seconds each on the OneDrive folder.
        ServeCommand::$passthroughVariables[] = 'PHP_INI_SCAN_DIR';
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
