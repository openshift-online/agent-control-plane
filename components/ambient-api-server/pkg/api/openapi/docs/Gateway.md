# Gateway

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Id** | Pointer to **string** |  | [optional] 
**Kind** | Pointer to **string** |  | [optional] 
**Href** | Pointer to **string** |  | [optional] 
**CreatedAt** | Pointer to **time.Time** |  | [optional] 
**UpdatedAt** | Pointer to **time.Time** |  | [optional] 
**Name** | **string** | Resource name (typically openshell-gateway) | 
**ProjectId** | **string** | The project this gateway belongs to | 
**Image** | Pointer to **string** | Gateway container image reference | [optional] 
**ServerDnsNames** | **[]string** | DNS names for TLS certificate generation | 
**Config** | Pointer to **string** | OpenShell gateway TOML configuration | [optional] 
**Labels** | Pointer to **string** | JSON-encoded labels | [optional] 
**Annotations** | Pointer to **string** | JSON-encoded annotations | [optional] 
**Oidc** | Pointer to [**GatewayOidc**](GatewayOidc.md) |  | [optional] 

## Methods

### NewGateway

`func NewGateway(name string, projectId string, serverDnsNames []string, ) *Gateway`

NewGateway instantiates a new Gateway object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGatewayWithDefaults

`func NewGatewayWithDefaults() *Gateway`

NewGatewayWithDefaults instantiates a new Gateway object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetId

`func (o *Gateway) GetId() string`

GetId returns the Id field if non-nil, zero value otherwise.

### GetIdOk

`func (o *Gateway) GetIdOk() (*string, bool)`

GetIdOk returns a tuple with the Id field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetId

`func (o *Gateway) SetId(v string)`

SetId sets Id field to given value.

### HasId

`func (o *Gateway) HasId() bool`

HasId returns a boolean if a field has been set.

### GetKind

`func (o *Gateway) GetKind() string`

GetKind returns the Kind field if non-nil, zero value otherwise.

### GetKindOk

`func (o *Gateway) GetKindOk() (*string, bool)`

GetKindOk returns a tuple with the Kind field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKind

`func (o *Gateway) SetKind(v string)`

SetKind sets Kind field to given value.

### HasKind

`func (o *Gateway) HasKind() bool`

HasKind returns a boolean if a field has been set.

### GetHref

`func (o *Gateway) GetHref() string`

GetHref returns the Href field if non-nil, zero value otherwise.

### GetHrefOk

`func (o *Gateway) GetHrefOk() (*string, bool)`

GetHrefOk returns a tuple with the Href field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetHref

`func (o *Gateway) SetHref(v string)`

SetHref sets Href field to given value.

### HasHref

`func (o *Gateway) HasHref() bool`

HasHref returns a boolean if a field has been set.

### GetCreatedAt

`func (o *Gateway) GetCreatedAt() time.Time`

GetCreatedAt returns the CreatedAt field if non-nil, zero value otherwise.

### GetCreatedAtOk

`func (o *Gateway) GetCreatedAtOk() (*time.Time, bool)`

GetCreatedAtOk returns a tuple with the CreatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCreatedAt

`func (o *Gateway) SetCreatedAt(v time.Time)`

SetCreatedAt sets CreatedAt field to given value.

### HasCreatedAt

`func (o *Gateway) HasCreatedAt() bool`

HasCreatedAt returns a boolean if a field has been set.

### GetUpdatedAt

`func (o *Gateway) GetUpdatedAt() time.Time`

GetUpdatedAt returns the UpdatedAt field if non-nil, zero value otherwise.

### GetUpdatedAtOk

`func (o *Gateway) GetUpdatedAtOk() (*time.Time, bool)`

GetUpdatedAtOk returns a tuple with the UpdatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUpdatedAt

`func (o *Gateway) SetUpdatedAt(v time.Time)`

SetUpdatedAt sets UpdatedAt field to given value.

### HasUpdatedAt

`func (o *Gateway) HasUpdatedAt() bool`

HasUpdatedAt returns a boolean if a field has been set.

### GetName

`func (o *Gateway) GetName() string`

GetName returns the Name field if non-nil, zero value otherwise.

### GetNameOk

`func (o *Gateway) GetNameOk() (*string, bool)`

GetNameOk returns a tuple with the Name field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetName

`func (o *Gateway) SetName(v string)`

SetName sets Name field to given value.


### GetProjectId

`func (o *Gateway) GetProjectId() string`

GetProjectId returns the ProjectId field if non-nil, zero value otherwise.

### GetProjectIdOk

`func (o *Gateway) GetProjectIdOk() (*string, bool)`

GetProjectIdOk returns a tuple with the ProjectId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetProjectId

`func (o *Gateway) SetProjectId(v string)`

SetProjectId sets ProjectId field to given value.


### GetImage

`func (o *Gateway) GetImage() string`

GetImage returns the Image field if non-nil, zero value otherwise.

### GetImageOk

`func (o *Gateway) GetImageOk() (*string, bool)`

GetImageOk returns a tuple with the Image field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetImage

`func (o *Gateway) SetImage(v string)`

SetImage sets Image field to given value.

### HasImage

`func (o *Gateway) HasImage() bool`

HasImage returns a boolean if a field has been set.

### GetServerDnsNames

`func (o *Gateway) GetServerDnsNames() []string`

GetServerDnsNames returns the ServerDnsNames field if non-nil, zero value otherwise.

### GetServerDnsNamesOk

`func (o *Gateway) GetServerDnsNamesOk() (*[]string, bool)`

GetServerDnsNamesOk returns a tuple with the ServerDnsNames field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetServerDnsNames

`func (o *Gateway) SetServerDnsNames(v []string)`

SetServerDnsNames sets ServerDnsNames field to given value.


### GetConfig

`func (o *Gateway) GetConfig() string`

GetConfig returns the Config field if non-nil, zero value otherwise.

### GetConfigOk

`func (o *Gateway) GetConfigOk() (*string, bool)`

GetConfigOk returns a tuple with the Config field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetConfig

`func (o *Gateway) SetConfig(v string)`

SetConfig sets Config field to given value.

### HasConfig

`func (o *Gateway) HasConfig() bool`

HasConfig returns a boolean if a field has been set.

### GetLabels

`func (o *Gateway) GetLabels() string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *Gateway) GetLabelsOk() (*string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *Gateway) SetLabels(v string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *Gateway) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *Gateway) GetAnnotations() string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *Gateway) GetAnnotationsOk() (*string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *Gateway) SetAnnotations(v string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *Gateway) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.

### GetOidc

`func (o *Gateway) GetOidc() GatewayOidc`

GetOidc returns the Oidc field if non-nil, zero value otherwise.

### GetOidcOk

`func (o *Gateway) GetOidcOk() (*GatewayOidc, bool)`

GetOidcOk returns a tuple with the Oidc field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetOidc

`func (o *Gateway) SetOidc(v GatewayOidc)`

SetOidc sets Oidc field to given value.

### HasOidc

`func (o *Gateway) HasOidc() bool`

HasOidc returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


