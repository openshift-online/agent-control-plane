# PolicyPatchRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Name** | Pointer to **string** |  | [optional] 
**Namespace** | Pointer to **string** |  | [optional] 
**Spec** | Pointer to **map[string]interface{}** |  | [optional] 
**Labels** | Pointer to **string** |  | [optional] 
**Annotations** | Pointer to **string** |  | [optional] 

## Methods

### NewPolicyPatchRequest

`func NewPolicyPatchRequest() *PolicyPatchRequest`

NewPolicyPatchRequest instantiates a new PolicyPatchRequest object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewPolicyPatchRequestWithDefaults

`func NewPolicyPatchRequestWithDefaults() *PolicyPatchRequest`

NewPolicyPatchRequestWithDefaults instantiates a new PolicyPatchRequest object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetName

`func (o *PolicyPatchRequest) GetName() string`

GetName returns the Name field if non-nil, zero value otherwise.

### GetNameOk

`func (o *PolicyPatchRequest) GetNameOk() (*string, bool)`

GetNameOk returns a tuple with the Name field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetName

`func (o *PolicyPatchRequest) SetName(v string)`

SetName sets Name field to given value.

### HasName

`func (o *PolicyPatchRequest) HasName() bool`

HasName returns a boolean if a field has been set.

### GetNamespace

`func (o *PolicyPatchRequest) GetNamespace() string`

GetNamespace returns the Namespace field if non-nil, zero value otherwise.

### GetNamespaceOk

`func (o *PolicyPatchRequest) GetNamespaceOk() (*string, bool)`

GetNamespaceOk returns a tuple with the Namespace field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetNamespace

`func (o *PolicyPatchRequest) SetNamespace(v string)`

SetNamespace sets Namespace field to given value.

### HasNamespace

`func (o *PolicyPatchRequest) HasNamespace() bool`

HasNamespace returns a boolean if a field has been set.

### GetSpec

`func (o *PolicyPatchRequest) GetSpec() map[string]interface{}`

GetSpec returns the Spec field if non-nil, zero value otherwise.

### GetSpecOk

`func (o *PolicyPatchRequest) GetSpecOk() (*map[string]interface{}, bool)`

GetSpecOk returns a tuple with the Spec field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSpec

`func (o *PolicyPatchRequest) SetSpec(v map[string]interface{})`

SetSpec sets Spec field to given value.

### HasSpec

`func (o *PolicyPatchRequest) HasSpec() bool`

HasSpec returns a boolean if a field has been set.

### GetLabels

`func (o *PolicyPatchRequest) GetLabels() string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *PolicyPatchRequest) GetLabelsOk() (*string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *PolicyPatchRequest) SetLabels(v string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *PolicyPatchRequest) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *PolicyPatchRequest) GetAnnotations() string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *PolicyPatchRequest) GetAnnotationsOk() (*string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *PolicyPatchRequest) SetAnnotations(v string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *PolicyPatchRequest) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


