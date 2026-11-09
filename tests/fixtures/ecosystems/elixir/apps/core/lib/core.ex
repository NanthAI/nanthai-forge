defmodule Shop.Core do
  @moduledoc "Prices in cents; # is not a comment inside this string."

  def total(items), do: Enum.reduce(items, 0, fn item, sum -> sum + price(item) end)

  defp price(%{cents: cents}), do: cents

  defmodule Item do
    defstruct [:cents]
  end
end
