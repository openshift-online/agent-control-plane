# SessionRuntimePatch

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**RuntimeVersion** | **int64** |  | 
**GatewayId** | Pointer to **string** |  | [optional] 
**GatewayWorkspace** | Pointer to **string** |  | [optional] 
**SandboxId** | Pointer to **string** |  | [optional] 
**SandboxName** | Pointer to **string** |  | [optional] 
**RuntimeBackend** | Pointer to **string** |  | [optional] 
**RunnerGeneration** | Pointer to **string** |  | [optional] 
**GatewayEndpoint** | Pointer to **string** |  | [optional] 
**GatewayCredentialId** | Pointer to **string** |  | [optional] 
**RuntimeStatus** | Pointer to **string** |  | [optional] 
**RuntimeError** | Pointer to **string** |  | [optional] 
**ExpectedPhase** | Pointer to **string** |  | [optional] 
**Phase** | Pointer to **string** |  | [optional] 
**KubeCrName** | Pointer to **string** |  | [optional] 
**KubeCrUid** | Pointer to **string** |  | [optional] 
**KubeNamespace** | Pointer to **string** |  | [optional] 
**Snapshots** | Pointer to **string** |  | [optional] 
**SdkSessionId** | Pointer to **string** |  | [optional] 
**ReconciledRepos** | Pointer to **string** |  | [optional] 
**ReconciledWorkflow** | Pointer to **string** |  | [optional] 
**StartTime** | Pointer to **time.Time** |  | [optional] 
**CompletionTime** | Pointer to **time.Time** |  | [optional] 

## Methods

### NewSessionRuntimePatch

`func NewSessionRuntimePatch(runtimeVersion int64, ) *SessionRuntimePatch`

NewSessionRuntimePatch instantiates a new SessionRuntimePatch object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewSessionRuntimePatchWithDefaults

`func NewSessionRuntimePatchWithDefaults() *SessionRuntimePatch`

NewSessionRuntimePatchWithDefaults instantiates a new SessionRuntimePatch object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetRuntimeVersion

`func (o *SessionRuntimePatch) GetRuntimeVersion() int64`

GetRuntimeVersion returns the RuntimeVersion field if non-nil, zero value otherwise.

### GetRuntimeVersionOk

`func (o *SessionRuntimePatch) GetRuntimeVersionOk() (*int64, bool)`

GetRuntimeVersionOk returns a tuple with the RuntimeVersion field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeVersion

`func (o *SessionRuntimePatch) SetRuntimeVersion(v int64)`

SetRuntimeVersion sets RuntimeVersion field to given value.


### GetGatewayId

`func (o *SessionRuntimePatch) GetGatewayId() string`

GetGatewayId returns the GatewayId field if non-nil, zero value otherwise.

### GetGatewayIdOk

`func (o *SessionRuntimePatch) GetGatewayIdOk() (*string, bool)`

GetGatewayIdOk returns a tuple with the GatewayId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayId

`func (o *SessionRuntimePatch) SetGatewayId(v string)`

SetGatewayId sets GatewayId field to given value.

### HasGatewayId

`func (o *SessionRuntimePatch) HasGatewayId() bool`

HasGatewayId returns a boolean if a field has been set.

### GetGatewayWorkspace

`func (o *SessionRuntimePatch) GetGatewayWorkspace() string`

GetGatewayWorkspace returns the GatewayWorkspace field if non-nil, zero value otherwise.

### GetGatewayWorkspaceOk

`func (o *SessionRuntimePatch) GetGatewayWorkspaceOk() (*string, bool)`

GetGatewayWorkspaceOk returns a tuple with the GatewayWorkspace field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayWorkspace

`func (o *SessionRuntimePatch) SetGatewayWorkspace(v string)`

SetGatewayWorkspace sets GatewayWorkspace field to given value.

### HasGatewayWorkspace

`func (o *SessionRuntimePatch) HasGatewayWorkspace() bool`

HasGatewayWorkspace returns a boolean if a field has been set.

### GetSandboxId

`func (o *SessionRuntimePatch) GetSandboxId() string`

GetSandboxId returns the SandboxId field if non-nil, zero value otherwise.

### GetSandboxIdOk

`func (o *SessionRuntimePatch) GetSandboxIdOk() (*string, bool)`

GetSandboxIdOk returns a tuple with the SandboxId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSandboxId

`func (o *SessionRuntimePatch) SetSandboxId(v string)`

SetSandboxId sets SandboxId field to given value.

### HasSandboxId

`func (o *SessionRuntimePatch) HasSandboxId() bool`

HasSandboxId returns a boolean if a field has been set.

### GetSandboxName

`func (o *SessionRuntimePatch) GetSandboxName() string`

GetSandboxName returns the SandboxName field if non-nil, zero value otherwise.

### GetSandboxNameOk

`func (o *SessionRuntimePatch) GetSandboxNameOk() (*string, bool)`

GetSandboxNameOk returns a tuple with the SandboxName field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSandboxName

`func (o *SessionRuntimePatch) SetSandboxName(v string)`

SetSandboxName sets SandboxName field to given value.

### HasSandboxName

`func (o *SessionRuntimePatch) HasSandboxName() bool`

HasSandboxName returns a boolean if a field has been set.

### GetRuntimeBackend

`func (o *SessionRuntimePatch) GetRuntimeBackend() string`

GetRuntimeBackend returns the RuntimeBackend field if non-nil, zero value otherwise.

### GetRuntimeBackendOk

`func (o *SessionRuntimePatch) GetRuntimeBackendOk() (*string, bool)`

GetRuntimeBackendOk returns a tuple with the RuntimeBackend field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeBackend

`func (o *SessionRuntimePatch) SetRuntimeBackend(v string)`

SetRuntimeBackend sets RuntimeBackend field to given value.

### HasRuntimeBackend

`func (o *SessionRuntimePatch) HasRuntimeBackend() bool`

HasRuntimeBackend returns a boolean if a field has been set.

### GetRunnerGeneration

`func (o *SessionRuntimePatch) GetRunnerGeneration() string`

GetRunnerGeneration returns the RunnerGeneration field if non-nil, zero value otherwise.

### GetRunnerGenerationOk

`func (o *SessionRuntimePatch) GetRunnerGenerationOk() (*string, bool)`

GetRunnerGenerationOk returns a tuple with the RunnerGeneration field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRunnerGeneration

`func (o *SessionRuntimePatch) SetRunnerGeneration(v string)`

SetRunnerGeneration sets RunnerGeneration field to given value.

### HasRunnerGeneration

`func (o *SessionRuntimePatch) HasRunnerGeneration() bool`

HasRunnerGeneration returns a boolean if a field has been set.

### GetGatewayEndpoint

`func (o *SessionRuntimePatch) GetGatewayEndpoint() string`

GetGatewayEndpoint returns the GatewayEndpoint field if non-nil, zero value otherwise.

### GetGatewayEndpointOk

`func (o *SessionRuntimePatch) GetGatewayEndpointOk() (*string, bool)`

GetGatewayEndpointOk returns a tuple with the GatewayEndpoint field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayEndpoint

`func (o *SessionRuntimePatch) SetGatewayEndpoint(v string)`

SetGatewayEndpoint sets GatewayEndpoint field to given value.

### HasGatewayEndpoint

`func (o *SessionRuntimePatch) HasGatewayEndpoint() bool`

HasGatewayEndpoint returns a boolean if a field has been set.

### GetGatewayCredentialId

`func (o *SessionRuntimePatch) GetGatewayCredentialId() string`

GetGatewayCredentialId returns the GatewayCredentialId field if non-nil, zero value otherwise.

### GetGatewayCredentialIdOk

`func (o *SessionRuntimePatch) GetGatewayCredentialIdOk() (*string, bool)`

GetGatewayCredentialIdOk returns a tuple with the GatewayCredentialId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayCredentialId

`func (o *SessionRuntimePatch) SetGatewayCredentialId(v string)`

SetGatewayCredentialId sets GatewayCredentialId field to given value.

### HasGatewayCredentialId

`func (o *SessionRuntimePatch) HasGatewayCredentialId() bool`

HasGatewayCredentialId returns a boolean if a field has been set.

### GetRuntimeStatus

`func (o *SessionRuntimePatch) GetRuntimeStatus() string`

GetRuntimeStatus returns the RuntimeStatus field if non-nil, zero value otherwise.

### GetRuntimeStatusOk

`func (o *SessionRuntimePatch) GetRuntimeStatusOk() (*string, bool)`

GetRuntimeStatusOk returns a tuple with the RuntimeStatus field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeStatus

`func (o *SessionRuntimePatch) SetRuntimeStatus(v string)`

SetRuntimeStatus sets RuntimeStatus field to given value.

### HasRuntimeStatus

`func (o *SessionRuntimePatch) HasRuntimeStatus() bool`

HasRuntimeStatus returns a boolean if a field has been set.

### GetRuntimeError

`func (o *SessionRuntimePatch) GetRuntimeError() string`

GetRuntimeError returns the RuntimeError field if non-nil, zero value otherwise.

### GetRuntimeErrorOk

`func (o *SessionRuntimePatch) GetRuntimeErrorOk() (*string, bool)`

GetRuntimeErrorOk returns a tuple with the RuntimeError field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeError

`func (o *SessionRuntimePatch) SetRuntimeError(v string)`

SetRuntimeError sets RuntimeError field to given value.

### HasRuntimeError

`func (o *SessionRuntimePatch) HasRuntimeError() bool`

HasRuntimeError returns a boolean if a field has been set.

### GetExpectedPhase

`func (o *SessionRuntimePatch) GetExpectedPhase() string`

GetExpectedPhase returns the ExpectedPhase field if non-nil, zero value otherwise.

### GetExpectedPhaseOk

`func (o *SessionRuntimePatch) GetExpectedPhaseOk() (*string, bool)`

GetExpectedPhaseOk returns a tuple with the ExpectedPhase field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetExpectedPhase

`func (o *SessionRuntimePatch) SetExpectedPhase(v string)`

SetExpectedPhase sets ExpectedPhase field to given value.

### HasExpectedPhase

`func (o *SessionRuntimePatch) HasExpectedPhase() bool`

HasExpectedPhase returns a boolean if a field has been set.

### GetPhase

`func (o *SessionRuntimePatch) GetPhase() string`

GetPhase returns the Phase field if non-nil, zero value otherwise.

### GetPhaseOk

`func (o *SessionRuntimePatch) GetPhaseOk() (*string, bool)`

GetPhaseOk returns a tuple with the Phase field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPhase

`func (o *SessionRuntimePatch) SetPhase(v string)`

SetPhase sets Phase field to given value.

### HasPhase

`func (o *SessionRuntimePatch) HasPhase() bool`

HasPhase returns a boolean if a field has been set.

### GetKubeCrName

`func (o *SessionRuntimePatch) GetKubeCrName() string`

GetKubeCrName returns the KubeCrName field if non-nil, zero value otherwise.

### GetKubeCrNameOk

`func (o *SessionRuntimePatch) GetKubeCrNameOk() (*string, bool)`

GetKubeCrNameOk returns a tuple with the KubeCrName field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKubeCrName

`func (o *SessionRuntimePatch) SetKubeCrName(v string)`

SetKubeCrName sets KubeCrName field to given value.

### HasKubeCrName

`func (o *SessionRuntimePatch) HasKubeCrName() bool`

HasKubeCrName returns a boolean if a field has been set.

### GetKubeCrUid

`func (o *SessionRuntimePatch) GetKubeCrUid() string`

GetKubeCrUid returns the KubeCrUid field if non-nil, zero value otherwise.

### GetKubeCrUidOk

`func (o *SessionRuntimePatch) GetKubeCrUidOk() (*string, bool)`

GetKubeCrUidOk returns a tuple with the KubeCrUid field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKubeCrUid

`func (o *SessionRuntimePatch) SetKubeCrUid(v string)`

SetKubeCrUid sets KubeCrUid field to given value.

### HasKubeCrUid

`func (o *SessionRuntimePatch) HasKubeCrUid() bool`

HasKubeCrUid returns a boolean if a field has been set.

### GetKubeNamespace

`func (o *SessionRuntimePatch) GetKubeNamespace() string`

GetKubeNamespace returns the KubeNamespace field if non-nil, zero value otherwise.

### GetKubeNamespaceOk

`func (o *SessionRuntimePatch) GetKubeNamespaceOk() (*string, bool)`

GetKubeNamespaceOk returns a tuple with the KubeNamespace field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKubeNamespace

`func (o *SessionRuntimePatch) SetKubeNamespace(v string)`

SetKubeNamespace sets KubeNamespace field to given value.

### HasKubeNamespace

`func (o *SessionRuntimePatch) HasKubeNamespace() bool`

HasKubeNamespace returns a boolean if a field has been set.

### GetSnapshots

`func (o *SessionRuntimePatch) GetSnapshots() string`

GetSnapshots returns the Snapshots field if non-nil, zero value otherwise.

### GetSnapshotsOk

`func (o *SessionRuntimePatch) GetSnapshotsOk() (*string, bool)`

GetSnapshotsOk returns a tuple with the Snapshots field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSnapshots

`func (o *SessionRuntimePatch) SetSnapshots(v string)`

SetSnapshots sets Snapshots field to given value.

### HasSnapshots

`func (o *SessionRuntimePatch) HasSnapshots() bool`

HasSnapshots returns a boolean if a field has been set.

### GetSdkSessionId

`func (o *SessionRuntimePatch) GetSdkSessionId() string`

GetSdkSessionId returns the SdkSessionId field if non-nil, zero value otherwise.

### GetSdkSessionIdOk

`func (o *SessionRuntimePatch) GetSdkSessionIdOk() (*string, bool)`

GetSdkSessionIdOk returns a tuple with the SdkSessionId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSdkSessionId

`func (o *SessionRuntimePatch) SetSdkSessionId(v string)`

SetSdkSessionId sets SdkSessionId field to given value.

### HasSdkSessionId

`func (o *SessionRuntimePatch) HasSdkSessionId() bool`

HasSdkSessionId returns a boolean if a field has been set.

### GetReconciledRepos

`func (o *SessionRuntimePatch) GetReconciledRepos() string`

GetReconciledRepos returns the ReconciledRepos field if non-nil, zero value otherwise.

### GetReconciledReposOk

`func (o *SessionRuntimePatch) GetReconciledReposOk() (*string, bool)`

GetReconciledReposOk returns a tuple with the ReconciledRepos field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetReconciledRepos

`func (o *SessionRuntimePatch) SetReconciledRepos(v string)`

SetReconciledRepos sets ReconciledRepos field to given value.

### HasReconciledRepos

`func (o *SessionRuntimePatch) HasReconciledRepos() bool`

HasReconciledRepos returns a boolean if a field has been set.

### GetReconciledWorkflow

`func (o *SessionRuntimePatch) GetReconciledWorkflow() string`

GetReconciledWorkflow returns the ReconciledWorkflow field if non-nil, zero value otherwise.

### GetReconciledWorkflowOk

`func (o *SessionRuntimePatch) GetReconciledWorkflowOk() (*string, bool)`

GetReconciledWorkflowOk returns a tuple with the ReconciledWorkflow field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetReconciledWorkflow

`func (o *SessionRuntimePatch) SetReconciledWorkflow(v string)`

SetReconciledWorkflow sets ReconciledWorkflow field to given value.

### HasReconciledWorkflow

`func (o *SessionRuntimePatch) HasReconciledWorkflow() bool`

HasReconciledWorkflow returns a boolean if a field has been set.

### GetStartTime

`func (o *SessionRuntimePatch) GetStartTime() time.Time`

GetStartTime returns the StartTime field if non-nil, zero value otherwise.

### GetStartTimeOk

`func (o *SessionRuntimePatch) GetStartTimeOk() (*time.Time, bool)`

GetStartTimeOk returns a tuple with the StartTime field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStartTime

`func (o *SessionRuntimePatch) SetStartTime(v time.Time)`

SetStartTime sets StartTime field to given value.

### HasStartTime

`func (o *SessionRuntimePatch) HasStartTime() bool`

HasStartTime returns a boolean if a field has been set.

### GetCompletionTime

`func (o *SessionRuntimePatch) GetCompletionTime() time.Time`

GetCompletionTime returns the CompletionTime field if non-nil, zero value otherwise.

### GetCompletionTimeOk

`func (o *SessionRuntimePatch) GetCompletionTimeOk() (*time.Time, bool)`

GetCompletionTimeOk returns a tuple with the CompletionTime field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCompletionTime

`func (o *SessionRuntimePatch) SetCompletionTime(v time.Time)`

SetCompletionTime sets CompletionTime field to given value.

### HasCompletionTime

`func (o *SessionRuntimePatch) HasCompletionTime() bool`

HasCompletionTime returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


