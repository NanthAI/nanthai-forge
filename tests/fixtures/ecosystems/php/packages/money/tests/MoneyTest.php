<?php
namespace Acme\Money\Tests;

use Acme\Money\Money;
use PHPUnit\Framework\TestCase;

class MoneyTest extends TestCase
{
    public function testCents(): void
    {
        $this->assertSame(5, (new Money(5))->cents());
    }
}
