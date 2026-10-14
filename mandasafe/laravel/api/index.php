<?php

/*
 * Vercel entry point (see vercel.json). Every request is routed here and handed to Laravel's
 * normal front controller.
 *
 * The runtime reports this file as the script (/api/index.php), and Symfony would then take
 * "/api" as the app's base path and strip it from every request, so /api/summary would reach
 * the router as /summary. Presenting the script as /index.php keeps the base path empty, the
 * same thing Laravel's own development server does.
 */

$_SERVER['SCRIPT_FILENAME'] = __DIR__ . '/../public/index.php';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';

require __DIR__ . '/../public/index.php';
