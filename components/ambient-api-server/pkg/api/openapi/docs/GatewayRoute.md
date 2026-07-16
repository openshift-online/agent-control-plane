# GatewayRoute

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Host** | Pointer to **string** | Hostname for the OpenShift Route. If empty, OpenShift assigns a hostname based on the cluster&#39;s default routing suffix. | [optional] 

## Methods

### NewGatewayRoute

`func NewGatewayRoute() *GatewayRoute`

NewGatewayRoute instantiates a new GatewayRoute object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGatewayRouteWithDefaults

`func NewGatewayRouteWithDefaults() *GatewayRoute`

NewGatewayRouteWithDefaults instantiates a new GatewayRoute object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetHost

`func (o *GatewayRoute) GetHost() string`

GetHost returns the Host field if non-nil, zero value otherwise.

### GetHostOk

`func (o *GatewayRoute) GetHostOk() (*string, bool)`

GetHostOk returns a tuple with the Host field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetHost

`func (o *GatewayRoute) SetHost(v string)`

SetHost sets Host field to given value.

### HasHost

`func (o *GatewayRoute) HasHost() bool`

HasHost returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


