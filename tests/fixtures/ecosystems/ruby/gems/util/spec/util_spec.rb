require "util"

RSpec.describe Util::Money do
  it "formats cents" do
    expect(Util::Money.new(250).to_s).to eq("2.50")
  end
end
