defmodule Shop.WebTest do
  use ExUnit.Case

  test "checkout", do: assert(Shop.Web.checkout(4) == 4)
end
