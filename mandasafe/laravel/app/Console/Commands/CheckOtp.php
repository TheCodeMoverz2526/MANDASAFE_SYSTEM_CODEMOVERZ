<?php

namespace App\Console\Commands;

use App\Services\OtpService;
use Illuminate\Console\Command;
use Throwable;

/**
 * Proves the verification credentials work, without going through the sign-in page.
 *
 *   php artisan mandasafe:otp-check                  what is configured
 *   php artisan mandasafe:otp-check +639171234599    send a real code to that number
 *   php artisan mandasafe:otp-check name@example.com send a real code to that address
 *
 * Sending a code costs money on a live account, so nothing is sent unless a destination is
 * given on the command line.
 */
class CheckOtp extends Command
{
    protected $signature = 'mandasafe:otp-check {destination? : A mobile number or email address to send a real code to}';

    protected $description = 'Show which verification channels are live, and optionally send a real code';

    public function handle(OtpService $otp): int
    {
        $status = $otp->status();

        $this->newLine();
        $this->line('  Verification channels');
        $this->line('  ---------------------');
        $this->line('  SMS    : ' . ($status['sms'] ? 'available via ' . $status['smsProvider'] : 'NOT configured'));
        $this->line('  Email  : ' . ($status['email'] ? 'available' : 'NOT configured'));

        if ($status['testMode']) {
            $this->newLine();
            $this->warn('  Test mode: no provider is contacted and the code is shown on the sign-in page.');
            $this->line('  Put VOCOTEXT_USERNAME and VOCOTEXT_PASSWORD in laravel/.env to send real messages.');
        }

        $destination = $this->argument('destination');

        if (! $destination) {
            $this->newLine();
            $this->line('  Add a number or an email address to send a real code, e.g.');
            $this->line('    php artisan mandasafe:otp-check +639171234599');
            $this->newLine();

            return self::SUCCESS;
        }

        $channel = str_contains($destination, '@') ? 'email' : 'sms';

        try {
            $driver = $otp->driverFor($channel);

            if ($channel === 'sms' && $driver === 'vocotext') {
                [$countryCode, $mobile] = $otp->splitPhone($destination);
                $this->newLine();
                $this->line('  Sending through Vocotext as country_code=' . $countryCode . ' mobile=' . $mobile);
            }

            // A provider-managed channel makes its own code; the others need one from here.
            $code = $otp->providerManagesCode($driver) ? null : str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);

            $result = $otp->send($driver, $destination, $code);

            $this->newLine();
            $this->info('  Sent through ' . $driver . '. Check the ' . ($channel === 'sms' ? 'phone' : 'inbox') . '.');

            if ($code !== null) {
                $this->line('  The code was ' . $code . ' (generated here, so it can be shown).');
            }
            if (! empty($result['uuid'])) {
                $this->line('  Provider reference: uuid=' . $result['uuid'] . ' sms_id=' . $result['ref']);
            }
            $this->newLine();

            return self::SUCCESS;
        } catch (Throwable $exception) {
            $this->newLine();
            $this->error('  Could not send: ' . $exception->getMessage());
            $this->newLine();

            return self::FAILURE;
        }
    }
}
