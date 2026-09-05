# SPIFFE Workload API protocol provenance

`workload.proto` is an unmodified copy of the public SPIFFE project's
[`standards/workloadapi.proto`](https://github.com/spiffe/spiffe/blob/99470b9abc825f14aa364dfa2c3b53b02ba5db5b/standards/workloadapi.proto),
pinned to revision `99470b9abc825f14aa364dfa2c3b53b02ba5db5b`.
Its SHA-256 is
`159d2146f9b16bee2737f3f22e1e21c956fa272d03bedc96d4cb3b1b44829fe6`.
The upstream Apache-2.0 license is preserved in `LICENSE`.

The component calls only `FetchX509SVID`, `FetchJWTSVID`, and
`ValidateJWTSVID`. Retaining the complete upstream protocol does not implement
the other RPCs, including the WIT profile. The imported Google protobuf Struct
definition is provided by the existing `@grpc/proto-loader` dependency.
