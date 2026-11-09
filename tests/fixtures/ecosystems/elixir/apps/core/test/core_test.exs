defmodule Shop.CoreTest do
  use ExUnit.Case
  alias Shop.Core

  test "total" do
    assert Core.total([%{cents: 2}, %{cents: 3}]) == 5
  end
end
