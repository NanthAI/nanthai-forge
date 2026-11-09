defmodule Shop.Web do
  alias Shop.{Core, Core.Item}

  def checkout(cents) do
    if cents > 0 do
      Core.total([%Item{cents: cents}])
    else
      0
    end
  end
end
