# ProjectRuntimePatch

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**RuntimeVersion** | **int64** |  | 
**RuntimeBackend** | Pointer to **string** |  | [optional] 
**GatewayId** | Pointer to **string** |  | [optional] 
**GatewayInstanceId** | Pointer to **string** |  | [optional] 
**GatewayEndpoint** | Pointer to **string** |  | [optional] 
**GatewayStatus** | Pointer to **string** |  | [optional] 
**GatewayError** | Pointer to **string** |  | [optional] 
**GatewayCredentialId** | Pointer to **string** |  | [optional] 
**GatewayAccountId** | Pointer to **string** |  | [optional] 
**GatewayAccountExpiresAt** | Pointer to **string** |  | [optional] 
**GatewayExternalReference** | Pointer to **string** |  | [optional] 

## Methods

### NewProjectRuntimePatch

`func NewProjectRuntimePatch(runtimeVersion int64, ) *ProjectRuntimePatch`

NewProjectRuntimePatch instantiates a new ProjectRuntimePatch object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewProjectRuntimePatchWithDefaults

`func NewProjectRuntimePatchWithDefaults() *ProjectRuntimePatch`

NewProjectRuntimePatchWithDefaults instantiates a new ProjectRuntimePatch object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetRuntimeVersion

`func (o *ProjectRuntimePatch) GetRuntimeVersion() int64`

GetRuntimeVersion returns the RuntimeVersion field if non-nil, zero value otherwise.

### GetRuntimeVersionOk

`func (o *ProjectRuntimePatch) GetRuntimeVersionOk() (*int64, bool)`

GetRuntimeVersionOk returns a tuple with the RuntimeVersion field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeVersion

`func (o *ProjectRuntimePatch) SetRuntimeVersion(v int64)`

SetRuntimeVersion sets RuntimeVersion field to given value.


### GetRuntimeBackend

`func (o *ProjectRuntimePatch) GetRuntimeBackend() string`

GetRuntimeBackend returns the RuntimeBackend field if non-nil, zero value otherwise.

### GetRuntimeBackendOk

`func (o *ProjectRuntimePatch) GetRuntimeBackendOk() (*string, bool)`

GetRuntimeBackendOk returns a tuple with the RuntimeBackend field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeBackend

`func (o *ProjectRuntimePatch) SetRuntimeBackend(v string)`

SetRuntimeBackend sets RuntimeBackend field to given value.

### HasRuntimeBackend

`func (o *ProjectRuntimePatch) HasRuntimeBackend() bool`

HasRuntimeBackend returns a boolean if a field has been set.

### GetGatewayId

`func (o *ProjectRuntimePatch) GetGatewayId() string`

GetGatewayId returns the GatewayId field if non-nil, zero value otherwise.

### GetGatewayIdOk

`func (o *ProjectRuntimePatch) GetGatewayIdOk() (*string, bool)`

GetGatewayIdOk returns a tuple with the GatewayId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayId

`func (o *ProjectRuntimePatch) SetGatewayId(v string)`

SetGatewayId sets GatewayId field to given value.

### HasGatewayId

`func (o *ProjectRuntimePatch) HasGatewayId() bool`

HasGatewayId returns a boolean if a field has been set.

### GetGatewayInstanceId

`func (o *ProjectRuntimePatch) GetGatewayInstanceId() string`

GetGatewayInstanceId returns the GatewayInstanceId field if non-nil, zero value otherwise.

### GetGatewayInstanceIdOk

`func (o *ProjectRuntimePatch) GetGatewayInstanceIdOk() (*string, bool)`

GetGatewayInstanceIdOk returns a tuple with the GatewayInstanceId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayInstanceId

`func (o *ProjectRuntimePatch) SetGatewayInstanceId(v string)`

SetGatewayInstanceId sets GatewayInstanceId field to given value.

### HasGatewayInstanceId

`func (o *ProjectRuntimePatch) HasGatewayInstanceId() bool`

HasGatewayInstanceId returns a boolean if a field has been set.

### GetGatewayEndpoint

`func (o *ProjectRuntimePatch) GetGatewayEndpoint() string`

GetGatewayEndpoint returns the GatewayEndpoint field if non-nil, zero value otherwise.

### GetGatewayEndpointOk

`func (o *ProjectRuntimePatch) GetGatewayEndpointOk() (*string, bool)`

GetGatewayEndpointOk returns a tuple with the GatewayEndpoint field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayEndpoint

`func (o *ProjectRuntimePatch) SetGatewayEndpoint(v string)`

SetGatewayEndpoint sets GatewayEndpoint field to given value.

### HasGatewayEndpoint

`func (o *ProjectRuntimePatch) HasGatewayEndpoint() bool`

HasGatewayEndpoint returns a boolean if a field has been set.

### GetGatewayStatus

`func (o *ProjectRuntimePatch) GetGatewayStatus() string`

GetGatewayStatus returns the GatewayStatus field if non-nil, zero value otherwise.

### GetGatewayStatusOk

`func (o *ProjectRuntimePatch) GetGatewayStatusOk() (*string, bool)`

GetGatewayStatusOk returns a tuple with the GatewayStatus field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayStatus

`func (o *ProjectRuntimePatch) SetGatewayStatus(v string)`

SetGatewayStatus sets GatewayStatus field to given value.

### HasGatewayStatus

`func (o *ProjectRuntimePatch) HasGatewayStatus() bool`

HasGatewayStatus returns a boolean if a field has been set.

### GetGatewayError

`func (o *ProjectRuntimePatch) GetGatewayError() string`

GetGatewayError returns the GatewayError field if non-nil, zero value otherwise.

### GetGatewayErrorOk

`func (o *ProjectRuntimePatch) GetGatewayErrorOk() (*string, bool)`

GetGatewayErrorOk returns a tuple with the GatewayError field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayError

`func (o *ProjectRuntimePatch) SetGatewayError(v string)`

SetGatewayError sets GatewayError field to given value.

### HasGatewayError

`func (o *ProjectRuntimePatch) HasGatewayError() bool`

HasGatewayError returns a boolean if a field has been set.

### GetGatewayCredentialId

`func (o *ProjectRuntimePatch) GetGatewayCredentialId() string`

GetGatewayCredentialId returns the GatewayCredentialId field if non-nil, zero value otherwise.

### GetGatewayCredentialIdOk

`func (o *ProjectRuntimePatch) GetGatewayCredentialIdOk() (*string, bool)`

GetGatewayCredentialIdOk returns a tuple with the GatewayCredentialId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayCredentialId

`func (o *ProjectRuntimePatch) SetGatewayCredentialId(v string)`

SetGatewayCredentialId sets GatewayCredentialId field to given value.

### HasGatewayCredentialId

`func (o *ProjectRuntimePatch) HasGatewayCredentialId() bool`

HasGatewayCredentialId returns a boolean if a field has been set.

### GetGatewayAccountId

`func (o *ProjectRuntimePatch) GetGatewayAccountId() string`

GetGatewayAccountId returns the GatewayAccountId field if non-nil, zero value otherwise.

### GetGatewayAccountIdOk

`func (o *ProjectRuntimePatch) GetGatewayAccountIdOk() (*string, bool)`

GetGatewayAccountIdOk returns a tuple with the GatewayAccountId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayAccountId

`func (o *ProjectRuntimePatch) SetGatewayAccountId(v string)`

SetGatewayAccountId sets GatewayAccountId field to given value.

### HasGatewayAccountId

`func (o *ProjectRuntimePatch) HasGatewayAccountId() bool`

HasGatewayAccountId returns a boolean if a field has been set.

### GetGatewayAccountExpiresAt

`func (o *ProjectRuntimePatch) GetGatewayAccountExpiresAt() string`

GetGatewayAccountExpiresAt returns the GatewayAccountExpiresAt field if non-nil, zero value otherwise.

### GetGatewayAccountExpiresAtOk

`func (o *ProjectRuntimePatch) GetGatewayAccountExpiresAtOk() (*string, bool)`

GetGatewayAccountExpiresAtOk returns a tuple with the GatewayAccountExpiresAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayAccountExpiresAt

`func (o *ProjectRuntimePatch) SetGatewayAccountExpiresAt(v string)`

SetGatewayAccountExpiresAt sets GatewayAccountExpiresAt field to given value.

### HasGatewayAccountExpiresAt

`func (o *ProjectRuntimePatch) HasGatewayAccountExpiresAt() bool`

HasGatewayAccountExpiresAt returns a boolean if a field has been set.

### GetGatewayExternalReference

`func (o *ProjectRuntimePatch) GetGatewayExternalReference() string`

GetGatewayExternalReference returns the GatewayExternalReference field if non-nil, zero value otherwise.

### GetGatewayExternalReferenceOk

`func (o *ProjectRuntimePatch) GetGatewayExternalReferenceOk() (*string, bool)`

GetGatewayExternalReferenceOk returns a tuple with the GatewayExternalReference field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayExternalReference

`func (o *ProjectRuntimePatch) SetGatewayExternalReference(v string)`

SetGatewayExternalReference sets GatewayExternalReference field to given value.

### HasGatewayExternalReference

`func (o *ProjectRuntimePatch) HasGatewayExternalReference() bool`

HasGatewayExternalReference returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


