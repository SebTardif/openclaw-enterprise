# Workspace snapshot storage

This standard-library Go module supplies trusted-host Btrfs capture and native
export, a portable content-addressed filesystem repository, and the
`oce-workspace-snapshot` operator command. See the
[feature reference](../../docs/reference/workspace-snapshots.md) for its exact
scope, commands, fidelity profile and verification procedure.

```sh
go test -race ./...
go vet ./...
go build -o ./bin/oce-workspace-snapshot ./cmd/oce-workspace-snapshot
```

The Btrfs integration case requires explicitly selected disposable Btrfs mounts
and appropriate privileges. Ordinary package tests do not create mounts or
reformat storage. The module does not provision a Kubernetes storage class,
stop application writers, or authorize tenant requests.
