# OpenShell protocol attribution

`openshell-gateway.proto` adapts public protocol definitions from
[NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) at release `v0.0.113`,
commit `455883905a7ace88e6e69834dc0685bfc799ad44`:

- [`proto/openshell.proto`](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/openshell.proto)
- [`proto/datamodel.proto`](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/datamodel.proto)
- [`proto/sandbox.proto`](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/sandbox.proto)

Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

These definitions are licensed under the Apache License, Version 2.0. A copy
is included in [LICENSE](LICENSE).

The local file combines the Health, CreateSandbox, GetSandbox, and DeleteSandbox
RPCs with their reachable message definitions. It omits unrelated RPCs and
messages, shortens comments, omits authorization descriptor options, and places
the imported metadata and policy messages in the local `openshell.v1` package.
It preserves the wire field numbers, types, and optional presence of the
included messages. All reachable launch-specification fields from the pinned
release are included. The same launch definitions were checked against
`v0.0.116`, commit `d1155aa70042d3e2ee49dbfa15346b108b7c1d92`.

Local omission of authorization descriptors does not alter or implement
upstream authorization. The gateway remains responsible for authenticating
and authorizing each RPC.
