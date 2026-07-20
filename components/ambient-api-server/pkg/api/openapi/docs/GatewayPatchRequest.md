# GatewayPatchRequest

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Name** | Pointer to **string** |  | [optional] 
**Image** | Pointer to **string** |  | [optional] 
**ServerDnsNames** | Pointer to **[]string** |  | [optional] 
**Config** | Pointer to **string** |  | [optional] 
**Labels** | Pointer to **string** |  | [optional] 
**Annotations** | Pointer to **string** |  | [optional] 
**Oidc** | Pointer to [**GatewayOidc**](GatewayOidc.md) |  | [optional] 
**Route** | Pointer to [**GatewayRoute**](GatewayRoute.md) |  | [optional] 
**RouteAddress** | Pointer to **string** | Externally reachable address assigned by the OpenShift Route (set by control plane) | [optional] 

## Methods

### NewGatewayPatchRequest

`func NewGatewayPatchRequest() *GatewayPatchRequest`

NewGatewayPatchRequest instantiates a new GatewayPatchRequest object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGatewayPatchRequestWithDefaults

`func NewGatewayPatchRequestWithDefaults() *GatewayPatchRequest`

NewGatewayPatchRequestWithDefaults instantiates a new GatewayPatchRequest object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetName

`func (o *GatewayPatchRequest) GetName() string`

GetName returns the Name field if non-nil, zero value otherwise.

### GetNameOk

`func (o *GatewayPatchRequest) GetNameOk() (*string, bool)`

GetNameOk returns a tuple with the Name field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetName

`func (o *GatewayPatchRequest) SetName(v string)`

SetName sets Name field to given value.

### HasName

`func (o *GatewayPatchRequest) HasName() bool`

HasName returns a boolean if a field has been set.

### GetImage

`func (o *GatewayPatchRequest) GetImage() string`

GetImage returns the Image field if non-nil, zero value otherwise.

### GetImageOk

`func (o *GatewayPatchRequest) GetImageOk() (*string, bool)`

GetImageOk returns a tuple with the Image field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetImage

`func (o *GatewayPatchRequest) SetImage(v string)`

SetImage sets Image field to given value.

### HasImage

`func (o *GatewayPatchRequest) HasImage() bool`

HasImage returns a boolean if a field has been set.

### GetServerDnsNames

`func (o *GatewayPatchRequest) GetServerDnsNames() []string`

GetServerDnsNames returns the ServerDnsNames field if non-nil, zero value otherwise.

### GetServerDnsNamesOk

`func (o *GatewayPatchRequest) GetServerDnsNamesOk() (*[]string, bool)`

GetServerDnsNamesOk returns a tuple with the ServerDnsNames field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetServerDnsNames

`func (o *GatewayPatchRequest) SetServerDnsNames(v []string)`

SetServerDnsNames sets ServerDnsNames field to given value.

### HasServerDnsNames

`func (o *GatewayPatchRequest) HasServerDnsNames() bool`

HasServerDnsNames returns a boolean if a field has been set.

### GetConfig

`func (o *GatewayPatchRequest) GetConfig() string`

GetConfig returns the Config field if non-nil, zero value otherwise.

### GetConfigOk

`func (o *GatewayPatchRequest) GetConfigOk() (*string, bool)`

GetConfigOk returns a tuple with the Config field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetConfig

`func (o *GatewayPatchRequest) SetConfig(v string)`

SetConfig sets Config field to given value.

### HasConfig

`func (o *GatewayPatchRequest) HasConfig() bool`

HasConfig returns a boolean if a field has been set.

### GetLabels

`func (o *GatewayPatchRequest) GetLabels() string`

GetLabels returns the Labels field if non-nil, zero value otherwise.

### GetLabelsOk

`func (o *GatewayPatchRequest) GetLabelsOk() (*string, bool)`

GetLabelsOk returns a tuple with the Labels field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetLabels

`func (o *GatewayPatchRequest) SetLabels(v string)`

SetLabels sets Labels field to given value.

### HasLabels

`func (o *GatewayPatchRequest) HasLabels() bool`

HasLabels returns a boolean if a field has been set.

### GetAnnotations

`func (o *GatewayPatchRequest) GetAnnotations() string`

GetAnnotations returns the Annotations field if non-nil, zero value otherwise.

### GetAnnotationsOk

`func (o *GatewayPatchRequest) GetAnnotationsOk() (*string, bool)`

GetAnnotationsOk returns a tuple with the Annotations field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAnnotations

`func (o *GatewayPatchRequest) SetAnnotations(v string)`

SetAnnotations sets Annotations field to given value.

### HasAnnotations

`func (o *GatewayPatchRequest) HasAnnotations() bool`

HasAnnotations returns a boolean if a field has been set.

### GetOidc

`func (o *GatewayPatchRequest) GetOidc() GatewayOidc`

GetOidc returns the Oidc field if non-nil, zero value otherwise.

### GetOidcOk

`func (o *GatewayPatchRequest) GetOidcOk() (*GatewayOidc, bool)`

GetOidcOk returns a tuple with the Oidc field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetOidc

`func (o *GatewayPatchRequest) SetOidc(v GatewayOidc)`

SetOidc sets Oidc field to given value.

### HasOidc

`func (o *GatewayPatchRequest) HasOidc() bool`

HasOidc returns a boolean if a field has been set.

### GetRoute

`func (o *GatewayPatchRequest) GetRoute() GatewayRoute`

GetRoute returns the Route field if non-nil, zero value otherwise.

### GetRouteOk

`func (o *GatewayPatchRequest) GetRouteOk() (*GatewayRoute, bool)`

GetRouteOk returns a tuple with the Route field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRoute

`func (o *GatewayPatchRequest) SetRoute(v GatewayRoute)`

SetRoute sets Route field to given value.

### HasRoute

`func (o *GatewayPatchRequest) HasRoute() bool`

HasRoute returns a boolean if a field has been set.

### GetRouteAddress

`func (o *GatewayPatchRequest) GetRouteAddress() string`

GetRouteAddress returns the RouteAddress field if non-nil, zero value otherwise.

### GetRouteAddressOk

`func (o *GatewayPatchRequest) GetRouteAddressOk() (*string, bool)`

GetRouteAddressOk returns a tuple with the RouteAddress field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRouteAddress

`func (o *GatewayPatchRequest) SetRouteAddress(v string)`

SetRouteAddress sets RouteAddress field to given value.

### HasRouteAddress

`func (o *GatewayPatchRequest) HasRouteAddress() bool`

HasRouteAddress returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


