<?php
declare(strict_types=1);

namespace Acme\Money;

final class Money
{
    public function __construct(private int $cents) {}

    public function cents(): int
    {
        return $this->cents; // "}" in a comment
    }

    private function format(): string
    {
        return "{$this->cents} cents";
    }
}
