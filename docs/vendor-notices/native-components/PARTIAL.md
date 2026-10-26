# Partial original native component notices

This collection preserves 39 exact original notice files from the two named Convex backend releases and selected pinned component source artifacts. It is **PARTIAL**: it is not a complete binary SBOM, dependency linkage inventory or license clearance. The original terms are unchanged. No native executable is included.

The inspected macOS arm64 and Linux x64 binaries contain V8 engine, Zstandard, SQLite and AWS-LC code. The selected lock files and source trees provide notice provenance; they do not establish every transitive linked component. Some retained V8/vendor notices are source-declared candidates, not assertions that each component is linked. SQLCipher linkage is not established and its source notice is not included. SQLite code presence alone does not establish a new copyright notice obligation.

The manifest records exact original bytes, official source URLs, archive members and scope. Complete Rust release target/features and nested prebuilt V8 component closure remain unresolved. Missing notice availability is advisory for local initialization; it does not gate starting an existing instance. See ../../native-dependency-licenses.md in the Forge source/package for the audit and remaining work.
