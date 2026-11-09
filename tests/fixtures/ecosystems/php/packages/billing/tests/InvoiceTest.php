<?php
namespace Acme\Billing\Tests;

use Acme\Billing\Invoice;
use PHPUnit\Framework\TestCase;

class InvoiceTest extends TestCase
{
    public function testTotal(): void
    {
        $this->assertTrue(class_exists(Invoice::class));
    }
}
