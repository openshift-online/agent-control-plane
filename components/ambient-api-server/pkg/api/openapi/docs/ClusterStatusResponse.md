# ClusterStatusResponse

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Id** | Pointer to **string** |  | [optional] 
**Status** | Pointer to **string** |  | [optional] 
**StatusMessage** | Pointer to **string** |  | [optional] 
**Capacity** | Pointer to **string** |  | [optional] 
**LastHeartbeatAt** | Pointer to **time.Time** |  | [optional] 

## Methods

### NewClusterStatusResponse

`func NewClusterStatusResponse() *ClusterStatusResponse`

NewClusterStatusResponse instantiates a new ClusterStatusResponse object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewClusterStatusResponseWithDefaults

`func NewClusterStatusResponseWithDefaults() *ClusterStatusResponse`

NewClusterStatusResponseWithDefaults instantiates a new ClusterStatusResponse object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetId

`func (o *ClusterStatusResponse) GetId() string`

GetId returns the Id field if non-nil, zero value otherwise.

### GetIdOk

`func (o *ClusterStatusResponse) GetIdOk() (*string, bool)`

GetIdOk returns a tuple with the Id field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetId

`func (o *ClusterStatusResponse) SetId(v string)`

SetId sets Id field to given value.

### HasId

`func (o *ClusterStatusResponse) HasId() bool`

HasId returns a boolean if a field has been set.

### GetStatus

`func (o *ClusterStatusResponse) GetStatus() string`

GetStatus returns the Status field if non-nil, zero value otherwise.

### GetStatusOk

`func (o *ClusterStatusResponse) GetStatusOk() (*string, bool)`

GetStatusOk returns a tuple with the Status field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStatus

`func (o *ClusterStatusResponse) SetStatus(v string)`

SetStatus sets Status field to given value.

### HasStatus

`func (o *ClusterStatusResponse) HasStatus() bool`

HasStatus returns a boolean if a field has been set.

### GetStatusMessage

`func (o *ClusterStatusResponse) GetStatusMessage() string`

GetStatusMessage returns the StatusMessage field if non-nil, zero value otherwise.

### GetStatusMessageOk

`func (o *ClusterStatusResponse) GetStatusMessageOk() (*string, bool)`

GetStatusMessageOk returns a tuple with the StatusMessage field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStatusMessage

`func (o *ClusterStatusResponse) SetStatusMessage(v string)`

SetStatusMessage sets StatusMessage field to given value.

### HasStatusMessage

`func (o *ClusterStatusResponse) HasStatusMessage() bool`

HasStatusMessage returns a boolean if a field has been set.

### GetCapacity

`func (o *ClusterStatusResponse) GetCapacity() string`

GetCapacity returns the Capacity field if non-nil, zero value otherwise.

### GetCapacityOk

`func (o *ClusterStatusResponse) GetCapacityOk() (*string, bool)`

GetCapacityOk returns a tuple with the Capacity field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCapacity

`func (o *ClusterStatusResponse) SetCapacity(v string)`

SetCapacity sets Capacity field to given value.

### HasCapacity

`func (o *ClusterStatusResponse) HasCapacity() bool`

HasCapacity returns a boolean if a field has been set.

### GetLastHeartbeatAt

`func (o *ClusterStatusResponse) GetLastHeartbeatAt() time.Time`

GetLastHeartbeatAt returns the LastHeartbeatAt field if non-nil, zero value otherwise.

### GetLastHeartbeatAtOk

`func (o *ClusterStatusResponse) GetLastHeartbeatAtOk() (*time.Time, bool)`

GetLastHeartbeatAtOk returns a tuple with the LastHeartbeatAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLastHeartbeatAt

`func (o *ClusterStatusResponse) SetLastHeartbeatAt(v time.Time)`

SetLastHeartbeatAt sets LastHeartbeatAt field to given value.

### HasLastHeartbeatAt

`func (o *ClusterStatusResponse) HasLastHeartbeatAt() bool`

HasLastHeartbeatAt returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


