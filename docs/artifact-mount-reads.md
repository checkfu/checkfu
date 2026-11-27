# Mounted artifact read measurements

## Method

Measured November 26, 2026 using Node 24.22.3, Bun 1.4.2, Vitest 5.1.1, Effect 4.1.5, Alchemy 2.0.0-beta.87, and Workerd 1.20261117.1 on an Apple M1 Max running arm64 macOS. The fixture exercises the deployed mount adapter, `SessionArtifactAccess`, and the Effect cache in `PinnedArtifact`. The session view supplies a pin to version one while the aggregate reports version two. Both storage lookups assert that the requested data still belongs to the mounted version.

```sh
CHECKFU_MEASURE_ARTIFACT_MOUNT=1 bun run --cwd apps/api test \
  test/ArtifactMount.test.ts --maxWorkers=1 --reporter=verbose
```

Run this test-only stack locally and wait for the Worker to be ready.

```sh
bun x alchemy dev --stage wd-artifact-reads --no-input \
  --config apps/api/test/workerd/ArtifactMountFixture.stack.ts
```

Collect the same cases sequentially from a second terminal.

```sh
set -e -o pipefail
for case_number in 0 1 2 3 4 5 6 7; do
  curl --fail --silent --show-error --max-time 180 "http://localhost:1390/$case_number"
  printf '\n'
done | jq -c '.[]'
```

The fixture uses files of 32 KiB and 100 MiB and manifests with one or 1,000 files. The measured file is last. A repeating byte pattern checks offsets without constructing a whole file buffer. Each pull allocates at most 256 KiB of file data. The reader validates the first and last byte of each chunk. Peak outstanding bytes count data returned by the adapter and still outstanding to that reader, including any in-flight result returned after cancellation. The count excludes underlying provider buffers, retained consumer references and garbage collector memory.

Each case has five cold/warm pairs per runtime. Cold starts with an empty Effect manifest cache. Warm uses the same access service. Workerd file and manifest reads use the production R2 reader against a local Alchemy R2 binding. The objects are staged outside the measured interval, and the cache setting applies to the Effect cache. First-byte time starts at mount open and ends at the reader's first chunk. Total time ends when the reader completes, cancels, or gets an access error. The fixture lets an already-started range settle before recording counts. Time comes from `performance.now()` in each runtime.

The existing native integration also passed in 984 ms across three model turns. It reads a small artifact through the production service boundaries and checks a refused write. The narrower Workerd matrix measures the mount and local R2 reads in a single Worker, with synthetic session and artifact state. It leaves cross-worker RPC cost, deployed R2 latency, and billed operations unmeasured.

```sh
bun run test:workerd test/workerd/PiSession.workerd.ts \
  -t 'mounts an artifact version as read-only files the model can read and cannot change' \
  --reporter=verbose
```

## Range measurements

The stream asks for at most 256 KiB per range. The session view is read to discover the mount, to list files, and again at every range request. The artifact's active state is checked for the file list and each permitted range. All cases had one cold manifest storage load and zero warm loads. The rows below count calls and bytes at the fixture boundaries. Workerd uses the local binding for each blob or manifest load.

| Case | Range calls | Pin reads | Artifact state checks | Blob reads | Requested bytes | Returned bytes | Consumed bytes | Peak outstanding bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full 32 KiB | 1 | 3 | 2 | 1 | 32,768 | 32,768 | 32,768 | 32,768 |
| Full 100 MiB | 400 | 402 | 401 | 400 | 104,857,600 | 104,857,600 | 104,857,600 | 262,144 |
| Random 4 KiB | 1 | 3 | 2 | 1 | 4,096 | 4,096 | 4,096 | 4,096 |
| Cancel after first delivery, Node | 1 | 3 | 2 | 1 | 262,144 | 262,144 | 262,144 | 262,144 |
| Cancel after first delivery, Workerd | 2 | 4 | 3 | 2 | 524,288 | 524,288 | 262,144 | 262,144 |
| Revoke after first delivery, Node | 2 | 4 | 2 | 1 | 524,288 | 262,144 | 262,144 | 262,144 |
| Revoke after first delivery, Workerd | 3 | 5 | 3 | 2 | 786,432 | 524,288 | 524,288 | 262,144 |

The range-edge check starts at offset 262,136 and requests 262,168 bytes. It reads 262,144 bytes from that offset and 24 bytes from offset 524,280. At EOF the stream is empty and the store sees no blob call.

The following tables give individual first-byte and total times in milliseconds, in run order, with total medians and ranges.

### Workerd with local R2

| Case | File size | Manifest entries | Cache | First byte (ms) | Total (ms) | Total median (ms) | Total range (ms) |
| --- | --- | ---: | --- | --- | --- | ---: | --- |
| full | 32 KiB | 1 | cold | 7, 2, 3, 1, 2 | 7, 2, 3, 1, 2 | 2 | 1–7 |
| full | 32 KiB | 1 | warm | 1, 1, 1, 1, 0 | 1, 1, 1, 1, 0 | 1 | 0–1 |
| full | 32 KiB | 1000 | cold | 5, 4, 3, 2, 2 | 5, 4, 3, 2, 2 | 3 | 2–5 |
| full | 32 KiB | 1000 | warm | 1, 1, 1, 2, 1 | 1, 1, 1, 2, 1 | 1 | 1–2 |
| full | 100 MiB | 1 | cold | 3, 2, 1, 2, 2 | 274, 242, 263, 257, 262 | 262 | 242–274 |
| full | 100 MiB | 1 | warm | 1, 0, 1, 1, 0 | 242, 271, 274, 251, 266 | 266 | 242–274 |
| full | 100 MiB | 1000 | cold | 5, 3, 2, 3, 3 | 309, 308, 288, 268, 271 | 288 | 268–309 |
| full | 100 MiB | 1000 | warm | 2, 2, 1, 1, 1 | 264, 257, 267, 276, 264 | 264 | 257–276 |
| random | 100 MiB | 1 | cold | 1, 1, 1, 1, 1 | 1, 1, 1, 1, 1 | 1 | 1–1 |
| random | 100 MiB | 1 | warm | 1, 1, 0, 0, 1 | 1, 1, 0, 0, 1 | 1 | 0–1 |
| random | 100 MiB | 1000 | cold | 3, 2, 2, 2, 2 | 3, 2, 2, 2, 2 | 2 | 2–3 |
| random | 100 MiB | 1000 | warm | 1, 1, 1, 0, 1 | 1, 1, 1, 0, 1 | 1 | 0–1 |
| cancel | 100 MiB | 1000 | cold | 5, 3, 2, 3, 2 | 5, 3, 2, 3, 2 | 3 | 2–5 |
| cancel | 100 MiB | 1000 | warm | 0, 1, 1, 1, 1 | 0, 1, 1, 1, 1 | 1 | 0–1 |
| revoke | 100 MiB | 1000 | cold | 2, 3, 2, 2, 2 | 3, 3, 2, 2, 2 | 2 | 2–3 |
| revoke | 100 MiB | 1000 | warm | 1, 1, 1, 1, 1 | 1, 1, 2, 1, 1 | 1 | 1–2 |

### Node with in-memory providers

| Case | File size | Manifest entries | Cache | First byte (ms) | Total (ms) | Total median (ms) | Total range (ms) |
| --- | --- | ---: | --- | --- | --- | ---: | --- |
| full | 32 KiB | 1 | cold | 0.212, 0.096, 0.091, 0.087, 0.081 | 0.226, 0.102, 0.094, 0.089, 0.084 | 0.094 | 0.084–0.226 |
| full | 32 KiB | 1 | warm | 0.08, 0.056, 0.062, 0.052, 0.05 | 0.09, 0.061, 0.065, 0.054, 0.053 | 0.061 | 0.053–0.09 |
| full | 32 KiB | 1000 | cold | 0.15, 0.138, 0.133, 0.125, 0.124 | 0.152, 0.14, 0.135, 0.127, 0.125 | 0.135 | 0.125–0.152 |
| full | 32 KiB | 1000 | warm | 0.116, 0.113, 0.102, 0.113, 0.341 | 0.118, 0.115, 0.104, 0.115, 0.343 | 0.115 | 0.104–0.343 |
| full | 100 MiB | 1 | cold | 0.098, 0.198, 0.141, 0.162, 0.184 | 23.919, 25.644, 15.798, 20.361, 19.33 | 20.361 | 15.798–25.644 |
| full | 100 MiB | 1 | warm | 0.138, 0.114, 0.122, 0.11, 0.139 | 32.022, 24.16, 20.418, 19.089, 20.215 | 20.418 | 19.089–32.022 |
| full | 100 MiB | 1000 | cold | 0.218, 0.263, 0.231, 0.271, 0.217 | 25.813, 23.508, 24.265, 25.286, 32.66 | 25.286 | 23.508–32.66 |
| full | 100 MiB | 1000 | warm | 0.154, 0.226, 0.166, 0.218, 0.167 | 21.024, 21.959, 24.82, 22.035, 18.191 | 21.959 | 18.191–24.82 |
| random | 100 MiB | 1 | cold | 0.256, 0.116, 0.146, 0.085, 0.087 | 0.263, 0.118, 0.148, 0.087, 0.089 | 0.118 | 0.087–0.263 |
| random | 100 MiB | 1 | warm | 0.082, 0.054, 0.051, 0.108, 0.052 | 0.084, 0.056, 0.053, 0.11, 0.053 | 0.056 | 0.053–0.11 |
| random | 100 MiB | 1000 | cold | 0.267, 0.18, 0.275, 0.191, 0.185 | 0.27, 0.182, 0.29, 0.193, 0.187 | 0.193 | 0.182–0.29 |
| random | 100 MiB | 1000 | warm | 0.147, 0.212, 0.148, 0.144, 0.147 | 0.149, 0.214, 0.152, 0.146, 0.15 | 0.15 | 0.146–0.214 |
| cancel | 100 MiB | 1000 | cold | 0.239, 0.197, 0.202, 0.246, 4.333 | 0.401, 0.2, 0.205, 0.25, 4.351 | 0.25 | 0.2–4.351 |
| cancel | 100 MiB | 1000 | warm | 0.157, 0.163, 0.157, 0.162, 0.153 | 0.16, 0.165, 0.159, 0.165, 0.164 | 0.164 | 0.159–0.165 |
| revoke | 100 MiB | 1000 | cold | 0.151, 0.127, 0.156, 0.135, 0.178 | 0.328, 0.144, 0.172, 0.15, 0.202 | 0.172 | 0.144–0.328 |
| revoke | 100 MiB | 1000 | warm | 0.104, 0.096, 0.115, 0.104, 0.102 | 0.122, 0.111, 0.13, 0.124, 0.12 | 0.122 | 0.111–0.13 |

## Revocation and cancellation

The default stream can start a range before the consumer asks for it. In Workerd it started the second range before the continuation for the first read ran. Cancellation closed the consumer's stream with only 256 KiB delivered, while that second range still finished at the storage boundary. Revoking the grant at that point let the already-authorized second range arrive. The third range hit the pin check, failed with `EIO`, and never reached storage.

In Node the immediate variants ended after the first delivered chunk. A second pair of Node cases holds storage on the second range after authorization, without an outstanding consumer read, then cancels or removes the grant. The cancel case receives 256 KiB and storage completes 512 KiB. The revoke case receives the two authorized chunks and gets `EIO` at the third range. A consumer can hold a 256 KiB chunk while the stream has one queued or in-flight chunk. The adapter does not cancel an upstream range that already started.

## Decision

Keep the current reader. The existing immutable manifest cache eliminates repeated manifest storage loads. The full 100 MiB median was 262–288 ms in local Workerd and 20–25 ms with in-memory providers. The local Workerd matrix gives similar full-read medians with one and 1,000 manifest entries. The savings available from just changing the file lookup are unclear.

A per-stream file descriptor can skip the linear search while bounding each offset and length against the original pinned manifest. The range authorization still has to confirm the same artifact and manifest and the artifact's active state. Discard the descriptor if either check fails. This can keep the existing bound of one queued or in-flight chunk and stop admission on cancellation. The per-range worker crossing remains.

An owning-Worker stream can open one range over RPC and send 256 KiB chunks under backpressure. It needs a grant and active-state check that still authorizes the original artifact and manifest before each chunk. Cancellation must propagate to the upstream reader, with staged and in-flight bytes bounded across R2, RPC and the consumer. Resolving grants across workers may trade a per-range blob RPC for a per-range authorization RPC, so measure both crossings. Preserve partial ranges and EOF.

For a prototype, use a minimum improvement of both 20% and 50 ms in the full 100 MiB median on a representative Worker path, with no more than 2 ms regression in first-byte median for the 4 KiB case. Treat those as engineering thresholds for this comparison. Compare equivalent workloads across fresh and reused caches and preserve the access and buffering checks before adopting a candidate.
