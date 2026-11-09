<?php
namespace Acme\Billing;

use Acme\Money\{Money, Currency as Unit};

interface Payable {}

class Invoice implements Payable
{
    public function total(Money $money): int
    {
        $double = function (int $x) use ($money) { return $x * 2; };
        return $double($money->cents());
    }
}

function invoice_helper(): Invoice
{
    return new Invoice();
}
