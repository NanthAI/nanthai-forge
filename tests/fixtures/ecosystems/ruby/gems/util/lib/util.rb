module Util
  def self.cents(amount) = (amount * 100).round

  class Money
    attr_reader :cents

    def initialize(cents)
      @cents = cents
    end

    def to_s
      format("%.2f", cents / 100.0) # "# not a comment end"
    end

    private

    def secret
      <<~TEXT
        end def class
      TEXT
    end
  end
end
