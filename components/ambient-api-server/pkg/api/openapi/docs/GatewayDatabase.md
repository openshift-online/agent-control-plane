# GatewayDatabase

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Type** | **string** | Database backend: sqlite, postgres | 
**StorageSize** | Pointer to **string** | PVC storage request for PostgreSQL data volume (default 5Gi) | [optional] [default to "5Gi"]
**Image** | Pointer to **string** | PostgreSQL container image (default postgres:16) | [optional] [default to "postgres:16"]
**ExternalSecretRef** | Pointer to **string** | Reserved for future use: name of a K8s Secret with a url key | [optional] 

## Methods

### NewGatewayDatabase

`func NewGatewayDatabase(type_ string, ) *GatewayDatabase`

NewGatewayDatabase instantiates a new GatewayDatabase object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGatewayDatabaseWithDefaults

`func NewGatewayDatabaseWithDefaults() *GatewayDatabase`

NewGatewayDatabaseWithDefaults instantiates a new GatewayDatabase object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetType

`func (o *GatewayDatabase) GetType() string`

GetType returns the Type field if non-nil, zero value otherwise.

### GetTypeOk

`func (o *GatewayDatabase) GetTypeOk() (*string, bool)`

GetTypeOk returns a tuple with the Type field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetType

`func (o *GatewayDatabase) SetType(v string)`

SetType sets Type field to given value.


### GetStorageSize

`func (o *GatewayDatabase) GetStorageSize() string`

GetStorageSize returns the StorageSize field if non-nil, zero value otherwise.

### GetStorageSizeOk

`func (o *GatewayDatabase) GetStorageSizeOk() (*string, bool)`

GetStorageSizeOk returns a tuple with the StorageSize field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetStorageSize

`func (o *GatewayDatabase) SetStorageSize(v string)`

SetStorageSize sets StorageSize field to given value.

### HasStorageSize

`func (o *GatewayDatabase) HasStorageSize() bool`

HasStorageSize returns a boolean if a field has been set.

### GetImage

`func (o *GatewayDatabase) GetImage() string`

GetImage returns the Image field if non-nil, zero value otherwise.

### GetImageOk

`func (o *GatewayDatabase) GetImageOk() (*string, bool)`

GetImageOk returns a tuple with the Image field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetImage

`func (o *GatewayDatabase) SetImage(v string)`

SetImage sets Image field to given value.

### HasImage

`func (o *GatewayDatabase) HasImage() bool`

HasImage returns a boolean if a field has been set.

### GetExternalSecretRef

`func (o *GatewayDatabase) GetExternalSecretRef() string`

GetExternalSecretRef returns the ExternalSecretRef field if non-nil, zero value otherwise.

### GetExternalSecretRefOk

`func (o *GatewayDatabase) GetExternalSecretRefOk() (*string, bool)`

GetExternalSecretRefOk returns a tuple with the ExternalSecretRef field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetExternalSecretRef

`func (o *GatewayDatabase) SetExternalSecretRef(v string)`

SetExternalSecretRef sets ExternalSecretRef field to given value.

### HasExternalSecretRef

`func (o *GatewayDatabase) HasExternalSecretRef() bool`

HasExternalSecretRef returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


