# Project

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Id** | Pointer to **string** |  | [optional] 
**Kind** | Pointer to **string** |  | [optional] 
**Href** | Pointer to **string** |  | [optional] 
**CreatedAt** | Pointer to **time.Time** |  | [optional] 
**UpdatedAt** | Pointer to **time.Time** |  | [optional] 
**RuntimeBackend** | Pointer to **string** |  | [optional] [readonly] 
**GatewayId** | Pointer to **string** |  | [optional] [readonly] 
**GatewayInstanceId** | Pointer to **string** |  | [optional] [readonly] 
**GatewayEndpoint** | Pointer to **string** |  | [optional] [readonly] 
**GatewayStatus** | Pointer to **string** |  | [optional] [readonly] 
**GatewayError** | Pointer to **string** |  | [optional] [readonly] 
**GatewayCredentialId** | Pointer to **string** |  | [optional] [readonly] 
**GatewayAccountId** | Pointer to **string** |  | [optional] [readonly] 
**GatewayAccountExpiresAt** | Pointer to **string** |  | [optional] [readonly] 
**GatewayExternalReference** | Pointer to **string** |  | [optional] [readonly] 
**RuntimeDeleted** | Pointer to **bool** |  | [optional] [readonly] 
**RuntimeVersion** | Pointer to **int64** |  | [optional] [readonly] 
**Name** | **string** |  | 
**Description** | Pointer to **string** |  | [optional] 
**Labels** | Pointer to **string** |  | [optional] 
**Annotations** | Pointer to **string** |  | [optional] 
**Prompt** | Pointer to **string** | Workspace-level context injected into every agent start in this project | [optional] 
**Status** | Pointer to **string** |  | [optional] 

## Methods

### NewProject

`func NewProject(name string, ) *Project`

NewProject instantiates a new Project object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewProjectWithDefaults

`func NewProjectWithDefaults() *Project`

NewProjectWithDefaults instantiates a new Project object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetId

`func (o *Project) GetId() string`

GetId returns the Id field if non-nil, zero value otherwise.

### GetIdOk

`func (o *Project) GetIdOk() (*string, bool)`

GetIdOk returns a tuple with the Id field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetId

`func (o *Project) SetId(v string)`

SetId sets Id field to given value.

### HasId

`func (o *Project) HasId() bool`

HasId returns a boolean if a field has been set.

### GetKind

`func (o *Project) GetKind() string`

GetKind returns the Kind field if non-nil, zero value otherwise.

### GetKindOk

`func (o *Project) GetKindOk() (*string, bool)`

GetKindOk returns a tuple with the Kind field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKind

`func (o *Project) SetKind(v string)`

SetKind sets Kind field to given value.

### HasKind

`func (o *Project) HasKind() bool`

HasKind returns a boolean if a field has been set.

### GetHref

`func (o *Project) GetHref() string`

GetHref returns the Href field if non-nil, zero value otherwise.

### GetHrefOk

`func (o *Project) GetHrefOk() (*string, bool)`

GetHrefOk returns a tuple with the Href field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetHref

`func (o *Project) SetHref(v string)`

SetHref sets Href field to given value.

### HasHref

`func (o *Project) HasHref() bool`

HasHref returns a boolean if a field has been set.

### GetCreatedAt

`func (o *Project) GetCreatedAt() time.Time`

GetCreatedAt returns the CreatedAt field if non-nil, zero value otherwise.

### GetCreatedAtOk

`func (o *Project) GetCreatedAtOk() (*time.Time, bool)`

GetCreatedAtOk returns a tuple with the CreatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCreatedAt

`func (o *Project) SetCreatedAt(v time.Time)`

SetCreatedAt sets CreatedAt field to given value.

### HasCreatedAt

`func (o *Project) HasCreatedAt() bool`

HasCreatedAt returns a boolean if a field has been set.

### GetUpdatedAt

`func (o *Project) GetUpdatedAt() time.Time`

GetUpdatedAt returns the UpdatedAt field if non-nil, zero value otherwise.

### GetUpdatedAtOk

`func (o *Project) GetUpdatedAtOk() (*time.Time, bool)`

GetUpdatedAtOk returns a tuple with the UpdatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUpdatedAt

`func (o *Project) SetUpdatedAt(v time.Time)`

SetUpdatedAt sets UpdatedAt field to given value.

### HasUpdatedAt

`func (o *Project) HasUpdatedAt() bool`

HasUpdatedAt returns a boolean if a field has been set.

### GetRuntimeBackend

`func (o *Project) GetRuntimeBackend() string`

GetRuntimeBackend returns the RuntimeBackend field if non-nil, zero value otherwise.

### GetRuntimeBackendOk

`func (o *Project) GetRuntimeBackendOk() (*string, bool)`

GetRuntimeBackendOk returns a tuple with the RuntimeBackend field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeBackend

`func (o *Project) SetRuntimeBackend(v string)`

SetRuntimeBackend sets RuntimeBackend field to given value.

### HasRuntimeBackend

`func (o *Project) HasRuntimeBackend() bool`

HasRuntimeBackend returns a boolean if a field has been set.

### GetGatewayId

`func (o *Project) GetGatewayId() string`

GetGatewayId returns the GatewayId field if non-nil, zero value otherwise.

### GetGatewayIdOk

`func (o *Project) GetGatewayIdOk() (*string, bool)`

GetGatewayIdOk returns a tuple with the GatewayId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayId

`func (o *Project) SetGatewayId(v string)`

SetGatewayId sets GatewayId field to given value.

### HasGatewayId

`func (o *Project) HasGatewayId() bool`

HasGatewayId returns a boolean if a field has been set.

### GetGatewayInstanceId

`func (o *Project) GetGatewayInstanceId() string`

GetGatewayInstanceId returns the GatewayInstanceId field if non-nil, zero value otherwise.

### GetGatewayInstanceIdOk

`func (o *Project) GetGatewayInstanceIdOk() (*string, bool)`

GetGatewayInstanceIdOk returns a tuple with the GatewayInstanceId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayInstanceId

`func (o *Project) SetGatewayInstanceId(v string)`

SetGatewayInstanceId sets GatewayInstanceId field to given value.

### HasGatewayInstanceId

`func (o *Project) HasGatewayInstanceId() bool`

HasGatewayInstanceId returns a boolean if a field has been set.

### GetGatewayEndpoint

`func (o *Project) GetGatewayEndpoint() string`

GetGatewayEndpoint returns the GatewayEndpoint field if non-nil, zero value otherwise.

### GetGatewayEndpointOk

`func (o *Project) GetGatewayEndpointOk() (*string, bool)`

GetGatewayEndpointOk returns a tuple with the GatewayEndpoint field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayEndpoint

`func (o *Project) SetGatewayEndpoint(v string)`

SetGatewayEndpoint sets GatewayEndpoint field to given value.

### HasGatewayEndpoint

`func (o *Project) HasGatewayEndpoint() bool`

HasGatewayEndpoint returns a boolean if a field has been set.

### GetGatewayStatus

`func (o *Project) GetGatewayStatus() string`

GetGatewayStatus returns the GatewayStatus field if non-nil, zero value otherwise.

### GetGatewayStatusOk

`func (o *Project) GetGatewayStatusOk() (*string, bool)`

GetGatewayStatusOk returns a tuple with the GatewayStatus field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayStatus

`func (o *Project) SetGatewayStatus(v string)`

SetGatewayStatus sets GatewayStatus field to given value.

### HasGatewayStatus

`func (o *Project) HasGatewayStatus() bool`

HasGatewayStatus returns a boolean if a field has been set.

### GetGatewayError

`func (o *Project) GetGatewayError() string`

GetGatewayError returns the GatewayError field if non-nil, zero value otherwise.

### GetGatewayErrorOk

`func (o *Project) GetGatewayErrorOk() (*string, bool)`

GetGatewayErrorOk returns a tuple with the GatewayError field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayError

`func (o *Project) SetGatewayError(v string)`

SetGatewayError sets GatewayError field to given value.

### HasGatewayError

`func (o *Project) HasGatewayError() bool`

HasGatewayError returns a boolean if a field has been set.

### GetGatewayCredentialId

`func (o *Project) GetGatewayCredentialId() string`

GetGatewayCredentialId returns the GatewayCredentialId field if non-nil, zero value otherwise.

### GetGatewayCredentialIdOk

`func (o *Project) GetGatewayCredentialIdOk() (*string, bool)`

GetGatewayCredentialIdOk returns a tuple with the GatewayCredentialId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayCredentialId

`func (o *Project) SetGatewayCredentialId(v string)`

SetGatewayCredentialId sets GatewayCredentialId field to given value.

### HasGatewayCredentialId

`func (o *Project) HasGatewayCredentialId() bool`

HasGatewayCredentialId returns a boolean if a field has been set.

### GetGatewayAccountId

`func (o *Project) GetGatewayAccountId() string`

GetGatewayAccountId returns the GatewayAccountId field if non-nil, zero value otherwise.

### GetGatewayAccountIdOk

`func (o *Project) GetGatewayAccountIdOk() (*string, bool)`

GetGatewayAccountIdOk returns a tuple with the GatewayAccountId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayAccountId

`func (o *Project) SetGatewayAccountId(v string)`

SetGatewayAccountId sets GatewayAccountId field to given value.

### HasGatewayAccountId

`func (o *Project) HasGatewayAccountId() bool`

HasGatewayAccountId returns a boolean if a field has been set.

### GetGatewayAccountExpiresAt

`func (o *Project) GetGatewayAccountExpiresAt() string`

GetGatewayAccountExpiresAt returns the GatewayAccountExpiresAt field if non-nil, zero value otherwise.

### GetGatewayAccountExpiresAtOk

`func (o *Project) GetGatewayAccountExpiresAtOk() (*string, bool)`

GetGatewayAccountExpiresAtOk returns a tuple with the GatewayAccountExpiresAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayAccountExpiresAt

`func (o *Project) SetGatewayAccountExpiresAt(v string)`

SetGatewayAccountExpiresAt sets GatewayAccountExpiresAt field to given value.

### HasGatewayAccountExpiresAt

`func (o *Project) HasGatewayAccountExpiresAt() bool`

HasGatewayAccountExpiresAt returns a boolean if a field has been set.

### GetGatewayExternalReference

`func (o *Project) GetGatewayExternalReference() string`

GetGatewayExternalReference returns the GatewayExternalReference field if non-nil, zero value otherwise.

### GetGatewayExternalReferenceOk

`func (o *Project) GetGatewayExternalReferenceOk() (*string, bool)`

GetGatewayExternalReferenceOk returns a tuple with the GatewayExternalReference field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGatewayExternalReference

`func (o *Project) SetGatewayExternalReference(v string)`

SetGatewayExternalReference sets GatewayExternalReference field to given value.

### HasGatewayExternalReference

`func (o *Project) HasGatewayExternalReference() bool`

HasGatewayExternalReference returns a boolean if a field has been set.

### GetRuntimeDeleted

`func (o *Project) GetRuntimeDeleted() bool`

GetRuntimeDeleted returns the RuntimeDeleted field if non-nil, zero value otherwise.

### GetRuntimeDeletedOk

`func (o *Project) GetRuntimeDeletedOk() (*bool, bool)`

GetRuntimeDeletedOk returns a tuple with the RuntimeDeleted field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeDeleted

`func (o *Project) SetRuntimeDeleted(v bool)`

SetRuntimeDeleted sets RuntimeDeleted field to given value.

### HasRuntimeDeleted

`func (o *Project) HasRuntimeDeleted() bool`

HasRuntimeDeleted returns a boolean if a field has been set.

### GetRuntimeVersion

`func (o *Project) GetRuntimeVersion() int64`

GetRuntimeVersion returns the RuntimeVersion field if non-nil, zero value otherwise.

### GetRuntimeVersionOk

`func (o *Project) GetRuntimeVersionOk() (*int64, bool)`

GetRuntimeVersionOk returns a tuple with the RuntimeVersion field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeVersion

`func (o *Project) SetRuntimeVersion(v int64)`

SetRuntimeVersion sets RuntimeVersion field to given value.

### HasRuntimeVersion

`func (o *Project) HasRuntimeVersion() bool`

HasRuntimeVersion returns a boolean if a field has been set.

### GetName

`func (o *Project) GetName() string`

GetName returns the Name field if non-nil, zero value otherwise.

### GetNameOk

`func (o *Project) GetNameOk() (*string, bool)`

GetNameOk returns a tuple with the Name field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetName

`func (o *Project) SetName(v string)`

SetName sets Name field to given value.


### GetDescription

`func (o *Project) GetDescription() string`

GetDescription returns the Description field if non-nil, zero value otherwise.

### GetDescriptionOk

`func (o *Project) GetDescriptionOk() (*string, bool)`

GetDescriptionOk returns a tuple with the Description field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetDescription

`func (o *Project) SetDescription(v string)`

SetDescription sets Description field to given value.

### HasDescription

`func (o *Project) HasDescription() bool`

HasDescription returns a boolean if a field has been set.

### GetLabels

`func (o *Project) GetLabels() string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *Project) GetLabelsOk() (*string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *Project) SetLabels(v string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *Project) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *Project) GetAnnotations() string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *Project) GetAnnotationsOk() (*string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *Project) SetAnnotations(v string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *Project) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.

### GetPrompt

`func (o *Project) GetPrompt() string`

GetPrompt returns the Prompt field if non-nil, zero value otherwise.

### GetPromptOk

`func (o *Project) GetPromptOk() (*string, bool)`

GetPromptOk returns a tuple with the Prompt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrompt

`func (o *Project) SetPrompt(v string)`

SetPrompt sets Prompt field to given value.

### HasPrompt

`func (o *Project) HasPrompt() bool`

HasPrompt returns a boolean if a field has been set.

### GetStatus

`func (o *Project) GetStatus() string`

GetStatus returns the Status field if non-nil, zero value otherwise.

### GetStatusOk

`func (o *Project) GetStatusOk() (*string, bool)`

GetStatusOk returns a tuple with the Status field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStatus

`func (o *Project) SetStatus(v string)`

SetStatus sets Status field to given value.

### HasStatus

`func (o *Project) HasStatus() bool`

HasStatus returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


