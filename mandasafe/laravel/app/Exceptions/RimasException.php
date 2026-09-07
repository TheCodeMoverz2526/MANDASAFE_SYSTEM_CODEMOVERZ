<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * A message meant for the person using MandaSafe, not a stack trace. Controllers turn these
 * into { "error": "..." } with the status code that endpoint used before the Laravel port.
 */
class RimasException extends RuntimeException
{
}
