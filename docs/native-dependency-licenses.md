# Pinned native backend license coverage

Status: partial audit; not a binary SBOM or redistribution clearance. Date: 2026-10-03. Requirement: FR-54 / F09.

Forge's [npm inventory](dependency-licenses.md) does not cover the separately downloaded self-host backend. This audit inspected both launcher pins' original release recipe, root license, locked package counts and native Cargo workspace declarations. No third-party source is vendored or relicensed, and no runtime access/default changes are applied.

| Official pin | Original source commit | Cargo.lock SHA-256 |
| --- | --- | --- |
| `precompiled-2026-09-28-5c7cb5b` | `5c7cb5bc7db457290f1769f95f1d1340912f7fd7` | `78a71666065da9f2baeeb0dce1b9d514d9ab2a469cf7f8302340f7a3050a2c8e` |
| `precompiled-2026-10-01-d2ca853` | `d2ca8533c52e2dbd8e55e20181988973dcbabe41` | `a76614c586d46385e09e6943bdcbfb38e4ee90dd9597cb0998e9576455c9dd77` |

Platform archive digests remain in the [install/upgrade recipe](operations.md). Both source-root `LICENSE.md` files have SHA-256 `563cea54ba1ad9d2a1b36f4a62b1ebdc3e1dcfb8776a7afee06c99aad5294588`. Their [FSL terms](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/LICENSE.md) govern separately from the Apache npm client and [Forge's licensing map](../LICENSE.md). Current native server licensing must not be labelled Apache merely from its client package or future-license text.

## Native release scope and actual checks

The pinned [precompiled ZIP recipe](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/.github/workflows/precompile.yml) builds `cargo build --release -p local_backend --bin convex-local-backend` with default features. This is distinct from the Docker release workflow. The build recipe was inspected, not executed. Its release assets include a root license; they do not provide a dependency-level binary inventory.

Actual macOS 26.5.2 arm64 checks used official `nightly-2026-06-28` (`rustc 1.98.0-nightly`, commit `13f1859f2`) from the source toolchain declaration. The separately installed stable default was preserved. Public checkouts and a fresh private Cargo cache remain outside Forge; no imported repository build, compiler, build script, hook or package lifecycle script was executed.

| Command / scenario | Actual result |
| --- | --- |
| Exact shallow source/tag acquisition, release/manifest/config inspection | Both original source commits matched the official tag refs; both tracked source trees remain clean. |
| `cargo +nightly-2026-06-28 metadata --locked --no-deps --format-version 1`, from each original source root | Passed for both pins; all 74 workspace name/version/license/path declarations are identical. 69 declare FSL; 5 declare Apache-2.0. No declaration is missing. |
| Native Python `tomllib` reading each original Cargo.lock | Both contain 1,022 external locked package instances, including 40 Git instances. These include workspace/dev/platform possibilities, not proven linked binary dependencies. |
| Full `cargo metadata --locked --format-version 1 --filter-platform aarch64-apple-darwin` | Interrupted after the upstream `rusty_v8` Chromium `buildtools` submodule fetch stalled. It produced no graph. No completed normal/build closure or Linux graph is claimed. |
| `cargo metadata --locked --offline --format-version 1 --filter-platform aarch64-apple-darwin` from the original source root | Failed explicitly on that unavailable V8 `buildtools` submodule; no substitution or edited manifest/lockfile. |

`--no-deps` is deliberately reported as workspace declarations only: its `resolve` is null. Cargo's [native metadata contract](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html) and [license fields](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields) define these facts. Absence of a resolved dependency/license record is unknown coverage.

To reproduce the successful inspection, acquire a separate public source checkout at either exact commit and run from its root:

```sh
cargo +nightly-2026-06-28 metadata --locked --no-deps --format-version 1 > workspace.json
python3 - <<'PYTHON'
import json
from pathlib import Path
root = Path.cwd().resolve()
metadata = json.loads(Path('workspace.json').read_text())
assert metadata['resolve'] is None
for package in sorted(metadata['packages'], key=lambda item: item['name']):
    path = Path(package['manifest_path']).relative_to(root).as_posix()
    print(package['name'], package['version'], package['license'], path, sep='\t')
PYTHON
```

The JSON output contains local absolute paths; retain it privately. The table below carries only public relative paths. The command needs the pinned toolchain but fetches no dependency graph and executes no repository build.

## Workspace declarations, identical across both pins

These include workspace members outside `local_backend`; they are not a selected executable's transitive dependency closure. The linked October source preserves each original declaration; the September commit above has the same records.

| Package | Version | Declared license | Original manifest |
| --- | --- | --- | --- |
| ai_gateway_jwt | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/ai_gateway_jwt/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/ai_gateway_jwt/Cargo.toml) |
| application | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/application/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/application/Cargo.toml) |
| async_lru | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/async_lru/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/async_lru/Cargo.toml) |
| authentication | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/authentication/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/authentication/Cargo.toml) |
| aws_s3 | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/aws_s3/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/aws_s3/Cargo.toml) |
| aws_utils | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/aws_utils/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/aws_utils/Cargo.toml) |
| backend_harness | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/backend_harness/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/backend_harness/Cargo.toml) |
| big_brain_client | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/big_brain_client/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/big_brain_client/Cargo.toml) |
| big_brain_private_api_types | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/big_brain_private_api_types/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/big_brain_private_api_types/Cargo.toml) |
| clusters | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/clusters/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/clusters/Cargo.toml) |
| cmd_util | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/cmd_util/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/cmd_util/Cargo.toml) |
| common | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/common/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/common/Cargo.toml) |
| config_loader | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/config_loader/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/config_loader/Cargo.toml) |
| convex | 0.10.4 | `Apache-2.0` | [crates/convex/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/convex/Cargo.toml) |
| convex_macro | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/convex_macro/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/convex_macro/Cargo.toml) |
| convex_sync_types | 0.10.4 | `Apache-2.0` | [crates/convex/sync_types/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/convex/sync_types/Cargo.toml) |
| database | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/database/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/database/Cargo.toml) |
| db_connection | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/db_connection/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/db_connection/Cargo.toml) |
| errors | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/errors/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/errors/Cargo.toml) |
| events | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/events/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/events/Cargo.toml) |
| exports | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/exports/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/exports/Cargo.toml) |
| file_storage | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/file_storage/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/file_storage/Cargo.toml) |
| fivetran_common | 0.0.1 | `Apache-2.0` | [crates/fivetran_common/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/fivetran_common/Cargo.toml) |
| fivetran_destination | 0.0.1 | `Apache-2.0` | [crates/fivetran_destination/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/fivetran_destination/Cargo.toml) |
| fivetran_source | 3.0.0 | `Apache-2.0` | [crates/fivetran_source/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/fivetran_source/Cargo.toml) |
| function_runner | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/function_runner/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/function_runner/Cargo.toml) |
| health_check | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/health_check/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/health_check/Cargo.toml) |
| http_client | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/http_client/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/http_client/Cargo.toml) |
| imbl_slab | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/imbl_slab/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/imbl_slab/Cargo.toml) |
| indexing | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/indexing/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/indexing/Cargo.toml) |
| interval_map | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/interval_map/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/interval_map/Cargo.toml) |
| isolate | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/isolate/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/isolate/Cargo.toml) |
| js_build | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/js_build/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/js_build/Cargo.toml) |
| json_trait | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/json_trait/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/json_trait/Cargo.toml) |
| keybroker | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/keybroker/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/keybroker/Cargo.toml) |
| load_generator | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/load_generator/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/load_generator/Cargo.toml) |
| local_backend | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/local_backend/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/local_backend/Cargo.toml) |
| log_interleaver | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/log_interleaver/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/log_interleaver/Cargo.toml) |
| log_streaming | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/log_streaming/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/log_streaming/Cargo.toml) |
| metrics | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/metrics/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/metrics/Cargo.toml) |
| migrations_model | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/migrations_model/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/migrations_model/Cargo.toml) |
| model | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/model/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/model/Cargo.toml) |
| mysql | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/mysql/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/mysql/Cargo.toml) |
| node_executor | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/node_executor/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/node_executor/Cargo.toml) |
| packed_value | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/packed_value/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/packed_value/Cargo.toml) |
| pb | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/pb/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/pb/Cargo.toml) |
| pb_build | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/pb_build/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/pb_build/Cargo.toml) |
| pb_data_sync | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/pb_data_sync/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/pb_data_sync/Cargo.toml) |
| pb_extras | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/pb_extras/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/pb_extras/Cargo.toml) |
| performance_stats | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/performance_stats/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/performance_stats/Cargo.toml) |
| postgres | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/postgres/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/postgres/Cargo.toml) |
| roles | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/roles/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/roles/Cargo.toml) |
| runtime | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/runtime/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/runtime/Cargo.toml) |
| search | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/search/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/search/Cargo.toml) |
| search_index_workers | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/search_index_workers/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/search_index_workers/Cargo.toml) |
| shape_inference | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/shape_inference/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/shape_inference/Cargo.toml) |
| sodium_secretbox | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/sodium_secretbox/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/sodium_secretbox/Cargo.toml) |
| sqlite | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/sqlite/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/sqlite/Cargo.toml) |
| storage | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/storage/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/storage/Cargo.toml) |
| storage_zip_reader | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/storage_zip_reader/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/storage_zip_reader/Cargo.toml) |
| streaming_export | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/streaming_export/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/streaming_export/Cargo.toml) |
| sync | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/sync/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/sync/Cargo.toml) |
| table_iteration | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/table_iteration/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/table_iteration/Cargo.toml) |
| text_search | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/text_search/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/text_search/Cargo.toml) |
| tuple_struct | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/tuple_struct/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/tuple_struct/Cargo.toml) |
| udf | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/udf/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/udf/Cargo.toml) |
| udf_metrics | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/udf_metrics/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/udf_metrics/Cargo.toml) |
| usage_gauges_tracking_worker | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/usage_gauges_tracking_worker/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/usage_gauges_tracking_worker/Cargo.toml) |
| usage_limits | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/usage_limits/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/usage_limits/Cargo.toml) |
| usage_tracking | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/usage_tracking/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/usage_tracking/Cargo.toml) |
| value | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/value/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/value/Cargo.toml) |
| vector | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/vector/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/vector/Cargo.toml) |
| webcrypto | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/webcrypto/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/webcrypto/Cargo.toml) |
| workos_client | 0.1.0 | `LicenseRef-FSL-1.1-Apache-2.0` | [crates/workos_client/Cargo.toml](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/crates/workos_client/Cargo.toml) |

## Bundled components still needing coverage

The exact lockfile pins Rust `v8` 149.2.11 to [Convex's rusty_v8 commit](https://github.com/get-convex/rusty_v8/blob/105b32c50433c4cf6eb77fe6a79e93b8637b20e2/Cargo.toml), whose crate declares MIT. Its [submodule manifest](https://github.com/get-convex/rusty_v8/blob/105b32c50433c4cf6eb77fe6a79e93b8637b20e2/.gitmodules) names V8, ICU, libc++, libc++abi, libunwind, Abseil, and other native/build sources. The Rust wrapper declaration does not inventory those components' terms or prove which objects are linked into either platform archive. `tikv-jemalloc-sys` also declares its Rust wrapper terms separately from its embedded native jemalloc submodule. Wrapper SPDX strings alone do not close the bundled audit.

Remaining work: obtain complete native metadata for the exact normal/build target selections; inspect external crate license files and required notices; inspect the actually selected vendored/prebuilt C/C++ components and platform-linked libraries; reconcile with the original release archives. No complete third-party notice set, Linux/macOS binary SBOM, patent/trademark permission or legal compatibility determination is claimed. The F09 full license/publication acceptance stays open.

## Retained experiment and rollback

The interrupted graph fetch/cache and successful metadata are retained privately under the owner's Forge audit scratch directory, with no credentials/source in committed evidence. The installed named Rust toolchain is an audit dependency; the existing default toolchain and application backend pins are unchanged. Resume only for the same original pins when the public submodule fetch works, or transfer this native inventory gap to the operator packaging review. No alternate graph resolver or new package manager is added. This documentation can be reverted independently of running instances, source, snapshots or user work.

## Original released license retention — 2026-10-03

Both exact [September](https://github.com/get-convex/convex-backend/releases/tag/precompiled-2026-09-28-5c7cb5b) and [October](https://github.com/get-convex/convex-backend/releases/tag/precompiled-2026-10-01-d2ca853) releases publish `LICENSE.md` separately from the platform ZIPs. Actual reviewed macOS arm64 ZIPs contain one executable each, with the unchanged archive digests recorded above/in the install recipe. The explicit release assets supply no dependency-level notice bundle or binary SBOM. The pinned [build recipe](https://github.com/get-convex/convex-backend/blob/d2ca8533c52e2dbd8e55e20181988973dcbabe41/.github/workflows/precompile.yml) corroborates this binary-only ZIP/separate-license packaging; it does not prove a complete linked dependency closure.

The original [released license bytes](vendor-notices/convex-backend-LICENSE.md) are identical for both pins: 3,861 bytes, SHA-256 `cee614f23a461cb4aba2910e7127ae0969bcf42a0a91a38d3e3449d843383086`. The released CRLF file normalizes to the previously inspected source SHA-256 `563cea54ba1ad9d2a1b36f4a62b1ebdc3e1dcfb8776a7afee06c99aad5294588`; its terms were not replaced. Forge retains the exact release bytes, not a generated license summary.

Fresh source-checkout self-host initialization copies this root notice offline to `LICENSE-convex-backend.md`, without changing the binary/version/digest or adding a download, argument, acceptance step or startup gate. If copying is unavailable, initialization reports that fact and preserves its existing behavior. Existing instances are unchanged; operators may copy the same notice beside their existing executable without restarting it. The npm package includes this notice and this inventory but does not redistribute the native backend. Actual installation/package evidence is in [operations](operations.md).

This repairs delivery of the original root license only. Normal/build target closure, external Rust and vendored/prebuilt native component notices, Linux binary dependency coverage and any redistribution compatibility determination remain unproven. The existing 1,022 locked instances and 74 workspace declarations are not relabelled as a linked binary inventory.


## Partial original component notice retention (2026-10-03)

Forge now retains the [partial original component collection](vendor-notices/native-components/PARTIAL.md) and its [byte/provenance manifest](vendor-notices/native-components/manifest.json). The collection contains 39 unchanged original notice files: the two exact Convex release notices, the selected Rusty V8 MIT wrapper, 26 source-declared V8 notice candidates, and selected checksum-verified AWS-LC/Zstandard/SQLite crate notices. Some candidates are not established as linked. SQLCipher linkage is unknown and its source notice is not included. This is **PARTIAL**, not a complete binary SBOM, licensing clearance or a replacement for original terms. Complete release target/features and nested prebuilt V8 linkage remain unresolved.

All four inspected existing native binary archives (September/October, macOS arm64/Linux x64) contain only the executable. Vendor release inventories provide no third-party notice/SBOM asset. Read-only symbol inspection identifies actual V8 internal engine, Zstandard, SQLite and AWS-LC text code in all four; source lock and tree entries alone are not treated as binary linkage proof. Exact source URLs, archive members, byte counts, SHA-256 and attribution scope accompany each retained original. The earlier Cargo.lock hashes and Convex released root notice match byte-for-byte. No executable or private operational path is included in this collection.

Fresh source-checkout local initialization copies the original Convex root notice to `LICENSE-convex-backend.md` and this collection to `native-component-notices/`, including its manifest and explicit partial disclosure. Notice copy failure remains advisory; installation and starting existing instances keep their existing capability. Existing local files are not overwritten. Original binaries, reviewed release pins and instance configuration are unchanged. There is no network notice fetch, new installation obligation or licensing-policy decision.

The local CLI npm artifact includes the exact original notice collection and native licensing documentation. It does **not** include the native backend executable or the source-checkout self-host scripts, and it is not a packaged backend. Native initialization continues through the existing source-checkout `scripts/selfhost.mjs` recipe. Offline package acceptance validates every installed original against both source bytes and the provenance manifest. See [operations](operations.md); complete native dependency notice closure remains open.
