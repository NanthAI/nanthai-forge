defmodule Shop.Core.MixProject do
  use Mix.Project

  def project do
    [app: :core, version: "0.1.0", build_path: "../../_build", deps_path: "../../deps", deps: deps()]
  end

  # A published dependency stays outside the graph.
  defp deps, do: [{:decimal, "~> 2.0"}]
end
