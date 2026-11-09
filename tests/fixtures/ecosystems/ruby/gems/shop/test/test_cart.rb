require "minitest/autorun"
require "shop"

class TestCart < Minitest::Test
  def test_total
    assert_equal 0, Shop::Cart.new.total([])
  end
end
