# ApplicationSyncRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Prune** | Pointer to **bool** | Override auto_prune for this sync only | [optional] 
**Revision** | Pointer to **string** | Override source_target_revision for this sync only | [optional] 
**PruneProject** | Pointer to **bool** | Required alongside prune to allow project deletion | [optional] 

## Methods

### NewApplicationSyncRequest

`func NewApplicationSyncRequest() *ApplicationSyncRequest`

NewApplicationSyncRequest instantiates a new ApplicationSyncRequest object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewApplicationSyncRequestWithDefaults

`func NewApplicationSyncRequestWithDefaults() *ApplicationSyncRequest`

NewApplicationSyncRequestWithDefaults instantiates a new ApplicationSyncRequest object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetPrune

`func (o *ApplicationSyncRequest) GetPrune() bool`

GetPrune returns the Prune field if non-nil, zero value otherwise.

### GetPruneOk

`func (o *ApplicationSyncRequest) GetPruneOk() (*bool, bool)`

GetPruneOk returns a tuple with the Prune field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPrune

`func (o *ApplicationSyncRequest) SetPrune(v bool)`

SetPrune sets Prune field to given value.

### HasPrune

`func (o *ApplicationSyncRequest) HasPrune() bool`

HasPrune returns a boolean if a field has been set.

### GetRevision

`func (o *ApplicationSyncRequest) GetRevision() string`

GetRevision returns the Revision field if non-nil, zero value otherwise.

### GetRevisionOk

`func (o *ApplicationSyncRequest) GetRevisionOk() (*string, bool)`

GetRevisionOk returns a tuple with the Revision field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRevision

`func (o *ApplicationSyncRequest) SetRevision(v string)`

SetRevision sets Revision field to given value.

### HasRevision

`func (o *ApplicationSyncRequest) HasRevision() bool`

HasRevision returns a boolean if a field has been set.

### GetPruneProject

`func (o *ApplicationSyncRequest) GetPruneProject() bool`

GetPruneProject returns the PruneProject field if non-nil, zero value otherwise.

### GetPruneProjectOk

`func (o *ApplicationSyncRequest) GetPruneProjectOk() (*bool, bool)`

GetPruneProjectOk returns a tuple with the PruneProject field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPruneProject

`func (o *ApplicationSyncRequest) SetPruneProject(v bool)`

SetPruneProject sets PruneProject field to given value.

### HasPruneProject

`func (o *ApplicationSyncRequest) HasPruneProject() bool`

HasPruneProject returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


