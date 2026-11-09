require "util"
require_relative "shop/version"

module Shop
  class Cart
    def total(items)
      items.sum { |item| item.cents } if items
    end
  end
end
