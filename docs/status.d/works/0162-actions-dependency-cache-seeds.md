- Actions can warm Cargo and uv dependency caches before a main check on a cache miss.
  Cargo fetches from the copied lockfile and manifest. With a compatible uv on PATH,
  uv uses locked wheels and omits local packages. Poetry, Maven, Gradle, NuGet and Yarn
  remain restore-only.
  [GitHub Actions checks](../../operations/github-actions-checks.md#toolchains-and-dependency-cache)
