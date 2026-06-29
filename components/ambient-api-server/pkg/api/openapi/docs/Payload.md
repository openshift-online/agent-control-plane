# Payload

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**SandboxPath** | **string** | Absolute path inside the sandbox where the content is delivered. | 
**Content** | Pointer to **string** | Inline string content to place at the sandbox path. | [optional] 
**RepoUrl** | Pointer to **string** | Git repository URL to clone into the sandbox path. | [optional] 
**Ref** | Pointer to **string** | Git ref to check out (branch, tag, or commit SHA). Only valid with repo_url. | [optional] 

## Methods

### NewPayload

`func NewPayload(sandboxPath string, ) *Payload`

NewPayload instantiates a new Payload object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewPayloadWithDefaults

`func NewPayloadWithDefaults() *Payload`

NewPayloadWithDefaults instantiates a new Payload object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetSandboxPath

`func (o *Payload) GetSandboxPath() string`

GetSandboxPath returns the SandboxPath field if non-nil, zero value otherwise.

### GetSandboxPathOk

`func (o *Payload) GetSandboxPathOk() (*string, bool)`

GetSandboxPathOk returns a tuple with the SandboxPath field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSandboxPath

`func (o *Payload) SetSandboxPath(v string)`

SetSandboxPath sets SandboxPath field to given value.


### GetContent

`func (o *Payload) GetContent() string`

GetContent returns the Content field if non-nil, zero value otherwise.

### GetContentOk

`func (o *Payload) GetContentOk() (*string, bool)`

GetContentOk returns a tuple with the Content field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetContent

`func (o *Payload) SetContent(v string)`

SetContent sets Content field to given value.

### HasContent

`func (o *Payload) HasContent() bool`

HasContent returns a boolean if a field has been set.

### GetRepoUrl

`func (o *Payload) GetRepoUrl() string`

GetRepoUrl returns the RepoUrl field if non-nil, zero value otherwise.

### GetRepoUrlOk

`func (o *Payload) GetRepoUrlOk() (*string, bool)`

GetRepoUrlOk returns a tuple with the RepoUrl field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRepoUrl

`func (o *Payload) SetRepoUrl(v string)`

SetRepoUrl sets RepoUrl field to given value.

### HasRepoUrl

`func (o *Payload) HasRepoUrl() bool`

HasRepoUrl returns a boolean if a field has been set.

### GetRef

`func (o *Payload) GetRef() string`

GetRef returns the Ref field if non-nil, zero value otherwise.

### GetRefOk

`func (o *Payload) GetRefOk() (*string, bool)`

GetRefOk returns a tuple with the Ref field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRef

`func (o *Payload) SetRef(v string)`

SetRef sets Ref field to given value.

### HasRef

`func (o *Payload) HasRef() bool`

HasRef returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


