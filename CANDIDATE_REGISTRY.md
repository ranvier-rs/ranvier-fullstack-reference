# M420 Candidate Registry

This repository carries a deterministic, local Cargo registry for the
maintainer-owned M420 fresh-consumer gate. It exposes the twelve package
artifacts from Ranvier `732d073` as the explicit prerelease
`0.51.0-m420.1` without publishing an irreversible crates.io version.

The candidate is deliberately narrow:

- consumer manifests use exact registry versions;
- `path`, Git, and `[patch]` sources are prohibited by the gate;
- Windows and Linux build, test, Schematic export, and HTTP request paths run
  from temporary projects outside `ranvier-workspace`;
- the committed registry can be served after cloning this repository without
  a sibling Ranvier checkout;
- the manifest retains the original package checksum and exact Ranvier commit.

It is not crates.io publication, independent adopter, or compatibility-window
evidence. A real release must still use the Ranvier release policy and compare
the bytes downloaded from its registry with the approved release artifacts.

## Verify

With Node 24, host Rust 1.98 for Windows, Podman, and the pinned
`rust:1.95.0-bookworm` image for Linux:

```text
node scripts/run-fresh-consumer-gate.mjs
```

Each invocation first rejects occupied host ports, then checks the registry's
source commit, candidate version, package count, and per-run identity. Consumer
and Cargo target files use a unique owned temporary directory; successful runs
and failed runs are cleaned by default. Add `--keep-failed-run` only when the
generated consumer and build output are needed for diagnosis. `--windows-only`
and `--linux-only` select one platform. Cargo builds use one job to bound memory;
the Linux target directory stays inside the disposable container to avoid large
compiler writes through the Windows bind mount. Evidence filenames include the
run ID and use exclusive creation, so a previous result is never overwritten.

To inspect the registry manually, start
`node scripts/serve-candidate-registry.mjs` and use the exact dependencies in
`consumer-smoke/Cargo.toml`. To regenerate it, first create the clean Ranvier
RQ11 provenance bundle, then run:

```text
node scripts/build-candidate-registry.mjs
```

Regeneration is expected to be byte-deterministic for the same provenance,
candidate version, and capture timestamp.
