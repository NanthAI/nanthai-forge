defmodule Shop.Web.MixProject do
  use Mix.Project

  def project do
    [app: :web, version: "0.1.0", build_path: "../../_build", deps_path: "../../deps", deps: deps()]
  end

  defp deps do
    [{:core, in_umbrella: true}]
  end
end
