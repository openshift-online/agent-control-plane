# AgentPatchRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Name** | Pointer to **string** |  | [optional] 
**DisplayName** | Pointer to **string** |  | [optional] 
**Description** | Pointer to **string** |  | [optional] 
**Prompt** | Pointer to **string** | Update agent prompt (access controlled by RBAC) | [optional] 
**RepoUrl** | Pointer to **string** |  | [optional] 
**LlmModel** | Pointer to **string** |  | [optional] 
**LlmTemperature** | Pointer to **float64** |  | [optional] 
**LlmMaxTokens** | Pointer to **int32** |  | [optional] 
**Entrypoint** | Pointer to **string** |  | [optional] 
**Providers** | Pointer to **[]string** |  | [optional] 
**Payloads** | Pointer to [**[]Payload**](Payload.md) |  | [optional] 
**Environment** | Pointer to **map[string]string** |  | [optional] 
**SandboxTemplate** | Pointer to [**SandboxTemplate**](SandboxTemplate.md) |  | [optional] 
**SandboxPolicy** | Pointer to **string** |  | [optional] 
**Labels** | Pointer to **string** |  | [optional] 
**Annotations** | Pointer to **string** |  | [optional] 

## Methods

### NewAgentPatchRequest

`func NewAgentPatchRequest() *AgentPatchRequest`

NewAgentPatchRequest instantiates a new AgentPatchRequest object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewAgentPatchRequestWithDefaults

`func NewAgentPatchRequestWithDefaults() *AgentPatchRequest`

NewAgentPatchRequestWithDefaults instantiates a new AgentPatchRequest object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetName

`func (o *AgentPatchRequest) GetName() string`

GetName returns the Name field if non-nil, zero value otherwise.

### GetNameOk

`func (o *AgentPatchRequest) GetNameOk() (*string, bool)`

GetNameOk returns a tuple with the Name field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetName

`func (o *AgentPatchRequest) SetName(v string)`

SetName sets Name field to given value.

### HasName

`func (o *AgentPatchRequest) HasName() bool`

HasName returns a boolean if a field has been set.

### GetDisplayName

`func (o *AgentPatchRequest) GetDisplayName() string`

GetDisplayName returns the DisplayName field if non-nil, zero value otherwise.

### GetDisplayNameOk

`func (o *AgentPatchRequest) GetDisplayNameOk() (*string, bool)`

GetDisplayNameOk returns a tuple with the DisplayName field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetDisplayName

`func (o *AgentPatchRequest) SetDisplayName(v string)`

SetDisplayName sets DisplayName field to given value.

### HasDisplayName

`func (o *AgentPatchRequest) HasDisplayName() bool`

HasDisplayName returns a boolean if a field has been set.

### GetDescription

`func (o *AgentPatchRequest) GetDescription() string`

GetDescription returns the Description field if non-nil, zero value otherwise.

### GetDescriptionOk

`func (o *AgentPatchRequest) GetDescriptionOk() (*string, bool)`

GetDescriptionOk returns a tuple with the Description field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetDescription

`func (o *AgentPatchRequest) SetDescription(v string)`

SetDescription sets Description field to given value.

### HasDescription

`func (o *AgentPatchRequest) HasDescription() bool`

HasDescription returns a boolean if a field has been set.

### GetPrompt

`func (o *AgentPatchRequest) GetPrompt() string`

GetPrompt returns the Prompt field if non-nil, zero value otherwise.

### GetPromptOk

`func (o *AgentPatchRequest) GetPromptOk() (*string, bool)`

GetPromptOk returns a tuple with the Prompt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrompt

`func (o *AgentPatchRequest) SetPrompt(v string)`

SetPrompt sets Prompt field to given value.

### HasPrompt

`func (o *AgentPatchRequest) HasPrompt() bool`

HasPrompt returns a boolean if a field has been set.

### GetRepoUrl

`func (o *AgentPatchRequest) GetRepoUrl() string`

GetRepoUrl returns the RepoUrl field if non-nil, zero value otherwise.

### GetRepoUrlOk

`func (o *AgentPatchRequest) GetRepoUrlOk() (*string, bool)`

GetRepoUrlOk returns a tuple with the RepoUrl field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRepoUrl

`func (o *AgentPatchRequest) SetRepoUrl(v string)`

SetRepoUrl sets RepoUrl field to given value.

### HasRepoUrl

`func (o *AgentPatchRequest) HasRepoUrl() bool`

HasRepoUrl returns a boolean if a field has been set.

### GetLlmModel

`func (o *AgentPatchRequest) GetLlmModel() string`

GetLlmModel returns the LlmModel field if non-nil, zero value otherwise.

### GetLlmModelOk

`func (o *AgentPatchRequest) GetLlmModelOk() (*string, bool)`

GetLlmModelOk returns a tuple with the LlmModel field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLlmModel

`func (o *AgentPatchRequest) SetLlmModel(v string)`

SetLlmModel sets LlmModel field to given value.

### HasLlmModel

`func (o *AgentPatchRequest) HasLlmModel() bool`

HasLlmModel returns a boolean if a field has been set.

### GetLlmTemperature

`func (o *AgentPatchRequest) GetLlmTemperature() float64`

GetLlmTemperature returns the LlmTemperature field if non-nil, zero value otherwise.

### GetLlmTemperatureOk

`func (o *AgentPatchRequest) GetLlmTemperatureOk() (*float64, bool)`

GetLlmTemperatureOk returns a tuple with the LlmTemperature field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLlmTemperature

`func (o *AgentPatchRequest) SetLlmTemperature(v float64)`

SetLlmTemperature sets LlmTemperature field to given value.

### HasLlmTemperature

`func (o *AgentPatchRequest) HasLlmTemperature() bool`

HasLlmTemperature returns a boolean if a field has been set.

### GetLlmMaxTokens

`func (o *AgentPatchRequest) GetLlmMaxTokens() int32`

GetLlmMaxTokens returns the LlmMaxTokens field if non-nil, zero value otherwise.

### GetLlmMaxTokensOk

`func (o *AgentPatchRequest) GetLlmMaxTokensOk() (*int32, bool)`

GetLlmMaxTokensOk returns a tuple with the LlmMaxTokens field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLlmMaxTokens

`func (o *AgentPatchRequest) SetLlmMaxTokens(v int32)`

SetLlmMaxTokens sets LlmMaxTokens field to given value.

### HasLlmMaxTokens

`func (o *AgentPatchRequest) HasLlmMaxTokens() bool`

HasLlmMaxTokens returns a boolean if a field has been set.

### GetEntrypoint

`func (o *AgentPatchRequest) GetEntrypoint() string`

GetEntrypoint returns the Entrypoint field if non-nil, zero value otherwise.

### GetEntrypointOk

`func (o *AgentPatchRequest) GetEntrypointOk() (*string, bool)`

GetEntrypointOk returns a tuple with the Entrypoint field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetEntrypoint

`func (o *AgentPatchRequest) SetEntrypoint(v string)`

SetEntrypoint sets Entrypoint field to given value.

### HasEntrypoint

`func (o *AgentPatchRequest) HasEntrypoint() bool`

HasEntrypoint returns a boolean if a field has been set.

### GetProviders

`func (o *AgentPatchRequest) GetProviders() []string`

GetProviders returns the Providers field if non-nil, zero value otherwise.

### GetProvidersOk

`func (o *AgentPatchRequest) GetProvidersOk() (*[]string, bool)`

GetProvidersOk returns a tuple with the Providers field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetProviders

`func (o *AgentPatchRequest) SetProviders(v []string)`

SetProviders sets Providers field to given value.

### HasProviders

`func (o *AgentPatchRequest) HasProviders() bool`

HasProviders returns a boolean if a field has been set.

### GetPayloads

`func (o *AgentPatchRequest) GetPayloads() []Payload`

GetPayloads returns the Payloads field if non-nil, zero value otherwise.

### GetPayloadsOk

`func (o *AgentPatchRequest) GetPayloadsOk() (*[]Payload, bool)`

GetPayloadsOk returns a tuple with the Payloads field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPayloads

`func (o *AgentPatchRequest) SetPayloads(v []Payload)`

SetPayloads sets Payloads field to given value.

### HasPayloads

`func (o *AgentPatchRequest) HasPayloads() bool`

HasPayloads returns a boolean if a field has been set.

### GetEnvironment

`func (o *AgentPatchRequest) GetEnvironment() map[string]string`

GetEnvironment returns the Environment field if non-nil, zero value otherwise.

### GetEnvironmentOk

`func (o *AgentPatchRequest) GetEnvironmentOk() (*map[string]string, bool)`

GetEnvironmentOk returns a tuple with the Environment field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetEnvironment

`func (o *AgentPatchRequest) SetEnvironment(v map[string]string)`

SetEnvironment sets Environment field to given value.

### HasEnvironment

`func (o *AgentPatchRequest) HasEnvironment() bool`

HasEnvironment returns a boolean if a field has been set.

### GetSandboxTemplate

`func (o *AgentPatchRequest) GetSandboxTemplate() SandboxTemplate`

GetSandboxTemplate returns the SandboxTemplate field if non-nil, zero value otherwise.

### GetSandboxTemplateOk

`func (o *AgentPatchRequest) GetSandboxTemplateOk() (*SandboxTemplate, bool)`

GetSandboxTemplateOk returns a tuple with the SandboxTemplate field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSandboxTemplate

`func (o *AgentPatchRequest) SetSandboxTemplate(v SandboxTemplate)`

SetSandboxTemplate sets SandboxTemplate field to given value.

### HasSandboxTemplate

`func (o *AgentPatchRequest) HasSandboxTemplate() bool`

HasSandboxTemplate returns a boolean if a field has been set.

### GetSandboxPolicy

`func (o *AgentPatchRequest) GetSandboxPolicy() string`

GetSandboxPolicy returns the SandboxPolicy field if non-nil, zero value otherwise.

### GetSandboxPolicyOk

`func (o *AgentPatchRequest) GetSandboxPolicyOk() (*string, bool)`

GetSandboxPolicyOk returns a tuple with the SandboxPolicy field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSandboxPolicy

`func (o *AgentPatchRequest) SetSandboxPolicy(v string)`

SetSandboxPolicy sets SandboxPolicy field to given value.

### HasSandboxPolicy

`func (o *AgentPatchRequest) HasSandboxPolicy() bool`

HasSandboxPolicy returns a boolean if a field has been set.

### GetLabels

`func (o *AgentPatchRequest) GetLabels() string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *AgentPatchRequest) GetLabelsOk() (*string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *AgentPatchRequest) SetLabels(v string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *AgentPatchRequest) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *AgentPatchRequest) GetAnnotations() string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *AgentPatchRequest) GetAnnotationsOk() (*string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *AgentPatchRequest) SetAnnotations(v string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *AgentPatchRequest) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


