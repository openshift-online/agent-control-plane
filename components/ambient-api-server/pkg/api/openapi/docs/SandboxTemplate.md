# SandboxTemplate

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Image** | Pointer to **string** | OCI container image reference for the sandbox. | [optional] 
**Resources** | Pointer to [**ResourceRequirements**](ResourceRequirements.md) |  | [optional] 
**Gpu** | Pointer to [**GpuRequirements**](GpuRequirements.md) |  | [optional] 
**RuntimeClassName** | Pointer to **string** | Kubernetes RuntimeClassName for the sandbox pod. | [optional] 
**DriverConfig** | Pointer to **map[string]interface{}** | OpenShell driver-specific opaque configuration (JSON). | [optional] 
**Labels** | Pointer to **map[string]string** | Labels applied to the sandbox compute resources. | [optional] 
**Annotations** | Pointer to **map[string]string** | Annotations applied to the sandbox compute resources. | [optional] 
**LogLevel** | Pointer to **string** | Sandbox supervisor log verbosity (debug, info, warn, error). | [optional] 

## Methods

### NewSandboxTemplate

`func NewSandboxTemplate() *SandboxTemplate`

NewSandboxTemplate instantiates a new SandboxTemplate object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewSandboxTemplateWithDefaults

`func NewSandboxTemplateWithDefaults() *SandboxTemplate`

NewSandboxTemplateWithDefaults instantiates a new SandboxTemplate object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetImage

`func (o *SandboxTemplate) GetImage() string`

GetImage returns the Image field if non-nil, zero value otherwise.

### GetImageOk

`func (o *SandboxTemplate) GetImageOk() (*string, bool)`

GetImageOk returns a tuple with the Image field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetImage

`func (o *SandboxTemplate) SetImage(v string)`

SetImage sets Image field to given value.

### HasImage

`func (o *SandboxTemplate) HasImage() bool`

HasImage returns a boolean if a field has been set.

### GetResources

`func (o *SandboxTemplate) GetResources() ResourceRequirements`

GetResources returns the Resources field if non-nil, zero value otherwise.

### GetResourcesOk

`func (o *SandboxTemplate) GetResourcesOk() (*ResourceRequirements, bool)`

GetResourcesOk returns a tuple with the Resources field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetResources

`func (o *SandboxTemplate) SetResources(v ResourceRequirements)`

SetResources sets Resources field to given value.

### HasResources

`func (o *SandboxTemplate) HasResources() bool`

HasResources returns a boolean if a field has been set.

### GetGpu

`func (o *SandboxTemplate) GetGpu() GpuRequirements`

GetGpu returns the Gpu field if non-nil, zero value otherwise.

### GetGpuOk

`func (o *SandboxTemplate) GetGpuOk() (*GpuRequirements, bool)`

GetGpuOk returns a tuple with the Gpu field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetGpu

`func (o *SandboxTemplate) SetGpu(v GpuRequirements)`

SetGpu sets Gpu field to given value.

### HasGpu

`func (o *SandboxTemplate) HasGpu() bool`

HasGpu returns a boolean if a field has been set.

### GetRuntimeClassName

`func (o *SandboxTemplate) GetRuntimeClassName() string`

GetRuntimeClassName returns the RuntimeClassName field if non-nil, zero value otherwise.

### GetRuntimeClassNameOk

`func (o *SandboxTemplate) GetRuntimeClassNameOk() (*string, bool)`

GetRuntimeClassNameOk returns a tuple with the RuntimeClassName field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRuntimeClassName

`func (o *SandboxTemplate) SetRuntimeClassName(v string)`

SetRuntimeClassName sets RuntimeClassName field to given value.

### HasRuntimeClassName

`func (o *SandboxTemplate) HasRuntimeClassName() bool`

HasRuntimeClassName returns a boolean if a field has been set.

### GetDriverConfig

`func (o *SandboxTemplate) GetDriverConfig() map[string]interface{}`

GetDriverConfig returns the DriverConfig field if non-nil, zero value otherwise.

### GetDriverConfigOk

`func (o *SandboxTemplate) GetDriverConfigOk() (*map[string]interface{}, bool)`

GetDriverConfigOk returns a tuple with the DriverConfig field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetDriverConfig

`func (o *SandboxTemplate) SetDriverConfig(v map[string]interface{})`

SetDriverConfig sets DriverConfig field to given value.

### HasDriverConfig

`func (o *SandboxTemplate) HasDriverConfig() bool`

HasDriverConfig returns a boolean if a field has been set.

### GetLabels

`func (o *SandboxTemplate) GetLabels() map[string]string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *SandboxTemplate) GetLabelsOk() (*map[string]string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *SandboxTemplate) SetLabels(v map[string]string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *SandboxTemplate) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *SandboxTemplate) GetAnnotations() map[string]string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *SandboxTemplate) GetAnnotationsOk() (*map[string]string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *SandboxTemplate) SetAnnotations(v map[string]string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *SandboxTemplate) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.

### GetLogLevel

`func (o *SandboxTemplate) GetLogLevel() string`

GetLogLevel returns the LogLevel field if non-nil, zero value otherwise.

### GetLogLevelOk

`func (o *SandboxTemplate) GetLogLevelOk() (*string, bool)`

GetLogLevelOk returns a tuple with the LogLevel field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLogLevel

`func (o *SandboxTemplate) SetLogLevel(v string)`

SetLogLevel sets LogLevel field to given value.

### HasLogLevel

`func (o *SandboxTemplate) HasLogLevel() bool`

HasLogLevel returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


