module github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk

go 1.25.0

toolchain go1.26.4

require (
	github.com/openshift-online/agent-control-plane/components/ambient-api-server v0.0.0
	google.golang.org/grpc v1.79.3
	gopkg.in/yaml.v3 v3.0.1
)

require (
	golang.org/x/net v0.56.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
	golang.org/x/text v0.38.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260715232425-e75dac1f907d // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)

replace github.com/openshift-online/agent-control-plane/components/ambient-api-server => ../../ambient-api-server
