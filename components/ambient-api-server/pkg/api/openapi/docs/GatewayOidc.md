# GatewayOidc

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Issuer** | Pointer to **string** | OIDC issuer URL; empty disables OIDC | [optional] 
**Audience** | Pointer to **string** | Expected aud claim value in JWT | [optional] [default to "openshell-cli"]
**JwksTtl** | Pointer to **int32** | JWKS key cache retention in seconds | [optional] [default to 3600]
**RolesClaim** | Pointer to **string** | Dot-delimited path to roles array in JWT claims | [optional] 
**AdminRole** | Pointer to **string** | Role name conferring admin access | [optional] 
**UserRole** | Pointer to **string** | Role name conferring standard user access | [optional] 
**ScopesClaim** | Pointer to **string** | Dot-delimited path to scopes array in JWT claims | [optional] 

## Methods

### NewGatewayOidc

`func NewGatewayOidc() *GatewayOidc`

NewGatewayOidc instantiates a new GatewayOidc object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewGatewayOidcWithDefaults

`func NewGatewayOidcWithDefaults() *GatewayOidc`

NewGatewayOidcWithDefaults instantiates a new GatewayOidc object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetIssuer

`func (o *GatewayOidc) GetIssuer() string`

GetIssuer returns the Issuer field if non-nil, zero value otherwise.

### GetIssuerOk

`func (o *GatewayOidc) GetIssuerOk() (*string, bool)`

GetIssuerOk returns a tuple with the Issuer field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetIssuer

`func (o *GatewayOidc) SetIssuer(v string)`

SetIssuer sets Issuer field to given value.

### HasIssuer

`func (o *GatewayOidc) HasIssuer() bool`

HasIssuer returns a boolean if a field has been set.

### GetAudience

`func (o *GatewayOidc) GetAudience() string`

GetAudience returns the Audience field if non-nil, zero value otherwise.

### GetAudienceOk

`func (o *GatewayOidc) GetAudienceOk() (*string, bool)`

GetAudienceOk returns a tuple with the Audience field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAudience

`func (o *GatewayOidc) SetAudience(v string)`

SetAudience sets Audience field to given value.

### HasAudience

`func (o *GatewayOidc) HasAudience() bool`

HasAudience returns a boolean if a field has been set.

### GetJwksTtl

`func (o *GatewayOidc) GetJwksTtl() int32`

GetJwksTtl returns the JwksTtl field if non-nil, zero value otherwise.

### GetJwksTtlOk

`func (o *GatewayOidc) GetJwksTtlOk() (*int32, bool)`

GetJwksTtlOk returns a tuple with the JwksTtl field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetJwksTtl

`func (o *GatewayOidc) SetJwksTtl(v int32)`

SetJwksTtl sets JwksTtl field to given value.

### HasJwksTtl

`func (o *GatewayOidc) HasJwksTtl() bool`

HasJwksTtl returns a boolean if a field has been set.

### GetRolesClaim

`func (o *GatewayOidc) GetRolesClaim() string`

GetRolesClaim returns the RolesClaim field if non-nil, zero value otherwise.

### GetRolesClaimOk

`func (o *GatewayOidc) GetRolesClaimOk() (*string, bool)`

GetRolesClaimOk returns a tuple with the RolesClaim field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetRolesClaim

`func (o *GatewayOidc) SetRolesClaim(v string)`

SetRolesClaim sets RolesClaim field to given value.

### HasRolesClaim

`func (o *GatewayOidc) HasRolesClaim() bool`

HasRolesClaim returns a boolean if a field has been set.

### GetAdminRole

`func (o *GatewayOidc) GetAdminRole() string`

GetAdminRole returns the AdminRole field if non-nil, zero value otherwise.

### GetAdminRoleOk

`func (o *GatewayOidc) GetAdminRoleOk() (*string, bool)`

GetAdminRoleOk returns a tuple with the AdminRole field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetAdminRole

`func (o *GatewayOidc) SetAdminRole(v string)`

SetAdminRole sets AdminRole field to given value.

### HasAdminRole

`func (o *GatewayOidc) HasAdminRole() bool`

HasAdminRole returns a boolean if a field has been set.

### GetUserRole

`func (o *GatewayOidc) GetUserRole() string`

GetUserRole returns the UserRole field if non-nil, zero value otherwise.

### GetUserRoleOk

`func (o *GatewayOidc) GetUserRoleOk() (*string, bool)`

GetUserRoleOk returns a tuple with the UserRole field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUserRole

`func (o *GatewayOidc) SetUserRole(v string)`

SetUserRole sets UserRole field to given value.

### HasUserRole

`func (o *GatewayOidc) HasUserRole() bool`

HasUserRole returns a boolean if a field has been set.

### GetScopesClaim

`func (o *GatewayOidc) GetScopesClaim() string`

GetScopesClaim returns the ScopesClaim field if non-nil, zero value otherwise.

### GetScopesClaimOk

`func (o *GatewayOidc) GetScopesClaimOk() (*string, bool)`

GetScopesClaimOk returns a tuple with the ScopesClaim field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetScopesClaim

`func (o *GatewayOidc) SetScopesClaim(v string)`

SetScopesClaim sets ScopesClaim field to given value.

### HasScopesClaim

`func (o *GatewayOidc) HasScopesClaim() bool`

HasScopesClaim returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


