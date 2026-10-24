# Licensing map

Copyright 2026 N:Forge contributors.

Unless a file or its directory specifies otherwise, original N:Forge server and control-plane code is licensed under [GNU AGPL version 3 only](LICENSE-AGPL-3.0-only.txt), SPDX `AGPL-3.0-only`.

The following original project materials are licensed under [Apache License 2.0](LICENSE-Apache-2.0.txt), SPDX `Apache-2.0`:

- Repository documentation, including `docs/`, README, agent instructions and contribution/security documentation.
- The current local portable implementation in `src/` (including loopback HTTP and MCP transports), browser client in `web/`, synthetic `tests/`, and source-free evaluation manifests in `evals/`. This is the Apache-2.0 root package; it contains no hosted server/control-plane implementation.
- Foundation tooling and configuration: `scripts/`, `.github/`, `.cursor/`, package metadata, and editor/Git configuration.
- Future portable protocol, graph schema/pack, SDK, CLI, MCP, client and runtime/executor-adapter packages, once created with an explicit package license notice.

Future application/server directories (`apps/web`, hosted indexer/control plane, `convex`, server persistence/auth implementations) inherit AGPL-3.0-only unless an explicit reviewed boundary says otherwise. A package manifest and local license notice must identify each implemented package's actual license. A path mentioned here does not imply that package exists.

Do not import AGPL server implementation into packages advertised as permissive. Shared contracts belong in independently maintained permissive packages. Dependency and third-party source licenses remain their own; preserve required notices. The archived conversation is project planning input, not authority to relicense third-party material.

The complete license texts govern; this map identifies scope. Source licensing does not grant rights to NanthAI or N:Forge trademarks. No copying or relicensing of NanthAI:Edge code is authorized merely by this map.

The repository starts private. A future public release must verify package boundaries, third-party notices and absence of private source/artifacts. Private visibility does not change the licenses above.

Brand asset exception: the NanthAi monograms and Forge marks, badges, lockups and browser/app icons remain all-rights-reserved NanthAi branding, reused by explicit owner authorization. See [asset notice](web/src/assets/NOTICE.md).
