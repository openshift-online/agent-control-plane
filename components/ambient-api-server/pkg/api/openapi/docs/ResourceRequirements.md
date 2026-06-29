# ResourceRequirements

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Cpu** | Pointer to **string** | CPU request/limit in Kubernetes quantity format (e.g., \&quot;2\&quot;, \&quot;500m\&quot;). | [optional] 
**Memory** | Pointer to **string** | Memory request/limit in Kubernetes quantity format (e.g., \&quot;4Gi\&quot;, \&quot;256Mi\&quot;). | [optional] 

## Methods

### NewResourceRequirements

`func NewResourceRequirements() *ResourceRequirements`

NewResourceRequirements instantiates a new ResourceRequirements object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewResourceRequirementsWithDefaults

`func NewResourceRequirementsWithDefaults() *ResourceRequirements`

NewResourceRequirementsWithDefaults instantiates a new ResourceRequirements object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetCpu

`func (o *ResourceRequirements) GetCpu() string`

GetCpu returns the Cpu field if non-nil, zero value otherwise.

### GetCpuOk

`func (o *ResourceRequirements) GetCpuOk() (*string, bool)`

GetCpuOk returns a tuple with the Cpu field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCpu

`func (o *ResourceRequirements) SetCpu(v string)`

SetCpu sets Cpu field to given value.

### HasCpu

`func (o *ResourceRequirements) HasCpu() bool`

HasCpu returns a boolean if a field has been set.

### GetMemory

`func (o *ResourceRequirements) GetMemory() string`

GetMemory returns the Memory field if non-nil, zero value otherwise.

### GetMemoryOk

`func (o *ResourceRequirements) GetMemoryOk() (*string, bool)`

GetMemoryOk returns a tuple with the Memory field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetMemory

`func (o *ResourceRequirements) SetMemory(v string)`

SetMemory sets Memory field to given value.

### HasMemory

`func (o *ResourceRequirements) HasMemory() bool`

HasMemory returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


