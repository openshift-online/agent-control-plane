# \DefaultAPI

All URIs are relative to *http://localhost:8000*

Method | HTTP request | Description
------------- | ------------- | -------------
[**ApiAmbientV1ApplicationsAppIdDelete**](DefaultAPI.md#ApiAmbientV1ApplicationsAppIdDelete) | **Delete** /api/ambient/v1/applications/{app_id} | Delete an application
[**ApiAmbientV1ApplicationsAppIdGet**](DefaultAPI.md#ApiAmbientV1ApplicationsAppIdGet) | **Get** /api/ambient/v1/applications/{app_id} | Get an application by id
[**ApiAmbientV1ApplicationsAppIdPatch**](DefaultAPI.md#ApiAmbientV1ApplicationsAppIdPatch) | **Patch** /api/ambient/v1/applications/{app_id} | Update an application
[**ApiAmbientV1ApplicationsAppIdRefreshPost**](DefaultAPI.md#ApiAmbientV1ApplicationsAppIdRefreshPost) | **Post** /api/ambient/v1/applications/{app_id}/refresh | Refresh application status
[**ApiAmbientV1ApplicationsAppIdSyncPost**](DefaultAPI.md#ApiAmbientV1ApplicationsAppIdSyncPost) | **Post** /api/ambient/v1/applications/{app_id}/sync | Trigger a sync operation
[**ApiAmbientV1ApplicationsGet**](DefaultAPI.md#ApiAmbientV1ApplicationsGet) | **Get** /api/ambient/v1/applications | Returns a list of applications
[**ApiAmbientV1ApplicationsPost**](DefaultAPI.md#ApiAmbientV1ApplicationsPost) | **Post** /api/ambient/v1/applications | Create a new application
[**ApiAmbientV1CredentialsCredIdDelete**](DefaultAPI.md#ApiAmbientV1CredentialsCredIdDelete) | **Delete** /api/ambient/v1/credentials/{cred_id} | Delete a credential
[**ApiAmbientV1CredentialsCredIdGet**](DefaultAPI.md#ApiAmbientV1CredentialsCredIdGet) | **Get** /api/ambient/v1/credentials/{cred_id} | Get a credential by id
[**ApiAmbientV1CredentialsCredIdPatch**](DefaultAPI.md#ApiAmbientV1CredentialsCredIdPatch) | **Patch** /api/ambient/v1/credentials/{cred_id} | Update a credential
[**ApiAmbientV1CredentialsCredIdTokenGet**](DefaultAPI.md#ApiAmbientV1CredentialsCredIdTokenGet) | **Get** /api/ambient/v1/credentials/{cred_id}/token | Get a decrypted token for a credential
[**ApiAmbientV1CredentialsGet**](DefaultAPI.md#ApiAmbientV1CredentialsGet) | **Get** /api/ambient/v1/credentials | Returns a list of credentials
[**ApiAmbientV1CredentialsPost**](DefaultAPI.md#ApiAmbientV1CredentialsPost) | **Post** /api/ambient/v1/credentials | Create a new credential
[**ApiAmbientV1ProjectSettingsGet**](DefaultAPI.md#ApiAmbientV1ProjectSettingsGet) | **Get** /api/ambient/v1/project_settings | Returns a list of project settings
[**ApiAmbientV1ProjectSettingsIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectSettingsIdDelete) | **Delete** /api/ambient/v1/project_settings/{id} | Delete a project settings by id
[**ApiAmbientV1ProjectSettingsIdGet**](DefaultAPI.md#ApiAmbientV1ProjectSettingsIdGet) | **Get** /api/ambient/v1/project_settings/{id} | Get a project settings by id
[**ApiAmbientV1ProjectSettingsIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectSettingsIdPatch) | **Patch** /api/ambient/v1/project_settings/{id} | Update a project settings
[**ApiAmbientV1ProjectSettingsPost**](DefaultAPI.md#ApiAmbientV1ProjectSettingsPost) | **Post** /api/ambient/v1/project_settings | Create a new project settings
[**ApiAmbientV1ProjectsGet**](DefaultAPI.md#ApiAmbientV1ProjectsGet) | **Get** /api/ambient/v1/projects | Returns a list of projects
[**ApiAmbientV1ProjectsIdAgentsAgentIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdDelete) | **Delete** /api/ambient/v1/projects/{id}/agents/{agent_id} | Delete an agent from a project
[**ApiAmbientV1ProjectsIdAgentsAgentIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdGet) | **Get** /api/ambient/v1/projects/{id}/agents/{agent_id} | Get an agent by id
[**ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet) | **Get** /api/ambient/v1/projects/{id}/agents/{agent_id}/ignition | Preview start context (dry run — no session created)
[**ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet) | **Get** /api/ambient/v1/projects/{id}/agents/{agent_id}/inbox | Read inbox messages for an agent (unread first)
[**ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete) | **Delete** /api/ambient/v1/projects/{id}/agents/{agent_id}/inbox/{msg_id} | Delete an inbox message
[**ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch) | **Patch** /api/ambient/v1/projects/{id}/agents/{agent_id}/inbox/{msg_id} | Mark an inbox message as read
[**ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost) | **Post** /api/ambient/v1/projects/{id}/agents/{agent_id}/inbox | Send a message to an agent&#39;s inbox
[**ApiAmbientV1ProjectsIdAgentsAgentIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdPatch) | **Patch** /api/ambient/v1/projects/{id}/agents/{agent_id} | Update an agent (name, prompt, labels, annotations)
[**ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet) | **Get** /api/ambient/v1/projects/{id}/agents/{agent_id}/sessions | Get session run history for an agent
[**ApiAmbientV1ProjectsIdAgentsAgentIdStartPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsAgentIdStartPost) | **Post** /api/ambient/v1/projects/{id}/agents/{agent_id}/start | Start an agent — creates a Session (idempotent)
[**ApiAmbientV1ProjectsIdAgentsGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsGet) | **Get** /api/ambient/v1/projects/{id}/agents | Returns a list of agents in a project
[**ApiAmbientV1ProjectsIdAgentsPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdAgentsPost) | **Post** /api/ambient/v1/projects/{id}/agents | Create an agent in a project
[**ApiAmbientV1ProjectsIdCredentialsCredIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsCredIdDelete) | **Delete** /api/ambient/v1/projects/{id}/credentials/{cred_id} | Delete a project credential
[**ApiAmbientV1ProjectsIdCredentialsCredIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsCredIdGet) | **Get** /api/ambient/v1/projects/{id}/credentials/{cred_id} | Get a project credential by id
[**ApiAmbientV1ProjectsIdCredentialsCredIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsCredIdPatch) | **Patch** /api/ambient/v1/projects/{id}/credentials/{cred_id} | Update a project credential
[**ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet) | **Get** /api/ambient/v1/projects/{id}/credentials/{cred_id}/token | Get a decrypted token for a project credential
[**ApiAmbientV1ProjectsIdCredentialsGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsGet) | **Get** /api/ambient/v1/projects/{id}/credentials | Returns a list of credentials for a project
[**ApiAmbientV1ProjectsIdCredentialsPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdCredentialsPost) | **Post** /api/ambient/v1/projects/{id}/credentials | Create a new credential in a project
[**ApiAmbientV1ProjectsIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdDelete) | **Delete** /api/ambient/v1/projects/{id} | Delete a project by id
[**ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete) | **Delete** /api/ambient/v1/projects/{id}/gateways/{gateway_id} | Delete a gateway
[**ApiAmbientV1ProjectsIdGatewaysGatewayIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdGatewaysGatewayIdGet) | **Get** /api/ambient/v1/projects/{id}/gateways/{gateway_id} | Get a gateway by id
[**ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch) | **Patch** /api/ambient/v1/projects/{id}/gateways/{gateway_id} | Update a gateway
[**ApiAmbientV1ProjectsIdGatewaysGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdGatewaysGet) | **Get** /api/ambient/v1/projects/{id}/gateways | Returns a list of gateways for a project
[**ApiAmbientV1ProjectsIdGatewaysPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdGatewaysPost) | **Post** /api/ambient/v1/projects/{id}/gateways | Create a new gateway in a project
[**ApiAmbientV1ProjectsIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdGet) | **Get** /api/ambient/v1/projects/{id} | Get a project by id
[**ApiAmbientV1ProjectsIdHomeGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdHomeGet) | **Get** /api/ambient/v1/projects/{id}/home | Project home — latest status for every Agent in this project
[**ApiAmbientV1ProjectsIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdPatch) | **Patch** /api/ambient/v1/projects/{id} | Update a project
[**ApiAmbientV1ProjectsIdPoliciesGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdPoliciesGet) | **Get** /api/ambient/v1/projects/{id}/policies | Returns a list of policies in a project
[**ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete) | **Delete** /api/ambient/v1/projects/{id}/policies/{policy_id} | Delete a policy from a project (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdPoliciesPolicyIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdPoliciesPolicyIdGet) | **Get** /api/ambient/v1/projects/{id}/policies/{policy_id} | Get a policy by id
[**ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch) | **Patch** /api/ambient/v1/projects/{id}/policies/{policy_id} | Update a policy (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdPoliciesPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdPoliciesPost) | **Post** /api/ambient/v1/projects/{id}/policies | Create a policy in a project (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdProvidersGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdProvidersGet) | **Get** /api/ambient/v1/projects/{id}/providers | Returns a list of providers in a project
[**ApiAmbientV1ProjectsIdProvidersPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdProvidersPost) | **Post** /api/ambient/v1/projects/{id}/providers | Create a provider in a project (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdProvidersProviderIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdProvidersProviderIdDelete) | **Delete** /api/ambient/v1/projects/{id}/providers/{provider_id} | Delete a provider from a project (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdProvidersProviderIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdProvidersProviderIdGet) | **Get** /api/ambient/v1/projects/{id}/providers/{provider_id} | Get a provider by id
[**ApiAmbientV1ProjectsIdProvidersProviderIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdProvidersProviderIdPatch) | **Patch** /api/ambient/v1/projects/{id}/providers/{provider_id} | Update a provider (internal — used by control plane reconciler)
[**ApiAmbientV1ProjectsIdScheduledSessionsGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsGet) | **Get** /api/ambient/v1/projects/{id}/scheduled-sessions | Returns a list of scheduled sessions in a project
[**ApiAmbientV1ProjectsIdScheduledSessionsPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsPost) | **Post** /api/ambient/v1/projects/{id}/scheduled-sessions | Create a scheduled session in a project
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete) | **Delete** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id} | Delete a scheduled session
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet) | **Get** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id} | Get a scheduled session by id
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch) | **Patch** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id} | Update a scheduled session
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost) | **Post** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/resume | Resume a suspended scheduled session (sets enabled&#x3D;true)
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet) | **Get** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/runs | List sessions triggered by this scheduled session
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost) | **Post** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/suspend | Suspend a scheduled session (sets enabled&#x3D;false)
[**ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost**](DefaultAPI.md#ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost) | **Post** /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/trigger | Manually trigger a scheduled session to run immediately
[**ApiAmbientV1ProjectsPost**](DefaultAPI.md#ApiAmbientV1ProjectsPost) | **Post** /api/ambient/v1/projects | Create a new project
[**ApiAmbientV1RoleBindingsGet**](DefaultAPI.md#ApiAmbientV1RoleBindingsGet) | **Get** /api/ambient/v1/role_bindings | Returns a list of roleBindings
[**ApiAmbientV1RoleBindingsIdDelete**](DefaultAPI.md#ApiAmbientV1RoleBindingsIdDelete) | **Delete** /api/ambient/v1/role_bindings/{id} | Delete a role binding by id
[**ApiAmbientV1RoleBindingsIdGet**](DefaultAPI.md#ApiAmbientV1RoleBindingsIdGet) | **Get** /api/ambient/v1/role_bindings/{id} | Get an roleBinding by id
[**ApiAmbientV1RoleBindingsIdPatch**](DefaultAPI.md#ApiAmbientV1RoleBindingsIdPatch) | **Patch** /api/ambient/v1/role_bindings/{id} | Update an roleBinding
[**ApiAmbientV1RoleBindingsPost**](DefaultAPI.md#ApiAmbientV1RoleBindingsPost) | **Post** /api/ambient/v1/role_bindings | Create a new roleBinding
[**ApiAmbientV1RolesGet**](DefaultAPI.md#ApiAmbientV1RolesGet) | **Get** /api/ambient/v1/roles | Returns a list of roles
[**ApiAmbientV1RolesIdDelete**](DefaultAPI.md#ApiAmbientV1RolesIdDelete) | **Delete** /api/ambient/v1/roles/{id} | Delete a role by id
[**ApiAmbientV1RolesIdGet**](DefaultAPI.md#ApiAmbientV1RolesIdGet) | **Get** /api/ambient/v1/roles/{id} | Get an role by id
[**ApiAmbientV1RolesIdPatch**](DefaultAPI.md#ApiAmbientV1RolesIdPatch) | **Patch** /api/ambient/v1/roles/{id} | Update an role
[**ApiAmbientV1RolesPost**](DefaultAPI.md#ApiAmbientV1RolesPost) | **Post** /api/ambient/v1/roles | Create a new role
[**ApiAmbientV1SessionsGet**](DefaultAPI.md#ApiAmbientV1SessionsGet) | **Get** /api/ambient/v1/sessions | Returns a list of sessions
[**ApiAmbientV1SessionsIdDelete**](DefaultAPI.md#ApiAmbientV1SessionsIdDelete) | **Delete** /api/ambient/v1/sessions/{id} | Delete a session by id
[**ApiAmbientV1SessionsIdEventsGet**](DefaultAPI.md#ApiAmbientV1SessionsIdEventsGet) | **Get** /api/ambient/v1/sessions/{id}/events | Stream live AG-UI events from the runner pod
[**ApiAmbientV1SessionsIdEventsHistoryGet**](DefaultAPI.md#ApiAmbientV1SessionsIdEventsHistoryGet) | **Get** /api/ambient/v1/sessions/{id}/events/history | List persisted compressed AG-UI events
[**ApiAmbientV1SessionsIdGet**](DefaultAPI.md#ApiAmbientV1SessionsIdGet) | **Get** /api/ambient/v1/sessions/{id} | Get an session by id
[**ApiAmbientV1SessionsIdMessagesGet**](DefaultAPI.md#ApiAmbientV1SessionsIdMessagesGet) | **Get** /api/ambient/v1/sessions/{id}/messages | List or stream session messages
[**ApiAmbientV1SessionsIdMessagesPost**](DefaultAPI.md#ApiAmbientV1SessionsIdMessagesPost) | **Post** /api/ambient/v1/sessions/{id}/messages | Push a message to a session
[**ApiAmbientV1SessionsIdPatch**](DefaultAPI.md#ApiAmbientV1SessionsIdPatch) | **Patch** /api/ambient/v1/sessions/{id} | Update an session
[**ApiAmbientV1SessionsIdStartPost**](DefaultAPI.md#ApiAmbientV1SessionsIdStartPost) | **Post** /api/ambient/v1/sessions/{id}/start | Start a session
[**ApiAmbientV1SessionsIdStatusPatch**](DefaultAPI.md#ApiAmbientV1SessionsIdStatusPatch) | **Patch** /api/ambient/v1/sessions/{id}/status | Update session status fields
[**ApiAmbientV1SessionsIdStopPost**](DefaultAPI.md#ApiAmbientV1SessionsIdStopPost) | **Post** /api/ambient/v1/sessions/{id}/stop | Stop a session
[**ApiAmbientV1SessionsPost**](DefaultAPI.md#ApiAmbientV1SessionsPost) | **Post** /api/ambient/v1/sessions | Create a new session
[**ApiAmbientV1UsersGet**](DefaultAPI.md#ApiAmbientV1UsersGet) | **Get** /api/ambient/v1/users | Returns a list of users
[**ApiAmbientV1UsersIdGet**](DefaultAPI.md#ApiAmbientV1UsersIdGet) | **Get** /api/ambient/v1/users/{id} | Get an user by id
[**ApiAmbientV1UsersIdPatch**](DefaultAPI.md#ApiAmbientV1UsersIdPatch) | **Patch** /api/ambient/v1/users/{id} | Update an user
[**ApiAmbientV1UsersPost**](DefaultAPI.md#ApiAmbientV1UsersPost) | **Post** /api/ambient/v1/users | Create a new user



## ApiAmbientV1ApplicationsAppIdDelete

> ApiAmbientV1ApplicationsAppIdDelete(ctx, appId).Execute()

Delete an application

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	appId := "appId_example" // string | The id of the application

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsAppIdDelete(context.Background(), appId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsAppIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**appId** | **string** | The id of the application | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsAppIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsAppIdGet

> Application ApiAmbientV1ApplicationsAppIdGet(ctx, appId).Execute()

Get an application by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	appId := "appId_example" // string | The id of the application

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsAppIdGet(context.Background(), appId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsAppIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsAppIdGet`: Application
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsAppIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**appId** | **string** | The id of the application | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsAppIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Application**](Application.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsAppIdPatch

> Application ApiAmbientV1ApplicationsAppIdPatch(ctx, appId).ApplicationPatchRequest(applicationPatchRequest).Execute()

Update an application

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	appId := "appId_example" // string | The id of the application
	applicationPatchRequest := *openapiclient.NewApplicationPatchRequest() // ApplicationPatchRequest | Updated application data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsAppIdPatch(context.Background(), appId).ApplicationPatchRequest(applicationPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsAppIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsAppIdPatch`: Application
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsAppIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**appId** | **string** | The id of the application | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsAppIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **applicationPatchRequest** | [**ApplicationPatchRequest**](ApplicationPatchRequest.md) | Updated application data | 

### Return type

[**Application**](Application.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsAppIdRefreshPost

> Application ApiAmbientV1ApplicationsAppIdRefreshPost(ctx, appId).Execute()

Refresh application status



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	appId := "appId_example" // string | The id of the application

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsAppIdRefreshPost(context.Background(), appId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsAppIdRefreshPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsAppIdRefreshPost`: Application
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsAppIdRefreshPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**appId** | **string** | The id of the application | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsAppIdRefreshPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Application**](Application.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsAppIdSyncPost

> Application ApiAmbientV1ApplicationsAppIdSyncPost(ctx, appId).ApplicationSyncRequest(applicationSyncRequest).Execute()

Trigger a sync operation



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	appId := "appId_example" // string | The id of the application
	applicationSyncRequest := *openapiclient.NewApplicationSyncRequest() // ApplicationSyncRequest | Optional sync parameters (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsAppIdSyncPost(context.Background(), appId).ApplicationSyncRequest(applicationSyncRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsAppIdSyncPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsAppIdSyncPost`: Application
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsAppIdSyncPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**appId** | **string** | The id of the application | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsAppIdSyncPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **applicationSyncRequest** | [**ApplicationSyncRequest**](ApplicationSyncRequest.md) | Optional sync parameters | 

### Return type

[**Application**](Application.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsGet

> ApplicationList ApiAmbientV1ApplicationsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of applications

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsGet`: ApplicationList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**ApplicationList**](ApplicationList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ApplicationsPost

> Application ApiAmbientV1ApplicationsPost(ctx).Application(application).Execute()

Create a new application

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	application := *openapiclient.NewApplication("Name_example", "SourceRepoUrl_example", "SourcePath_example", "DestinationProject_example") // Application | Application data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ApplicationsPost(context.Background()).Application(application).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ApplicationsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ApplicationsPost`: Application
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ApplicationsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ApplicationsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **application** | [**Application**](Application.md) | Application data | 

### Return type

[**Application**](Application.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsCredIdDelete

> ApiAmbientV1CredentialsCredIdDelete(ctx, credId).Execute()

Delete a credential

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsCredIdDelete(context.Background(), credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsCredIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsCredIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsCredIdGet

> Credential ApiAmbientV1CredentialsCredIdGet(ctx, credId).Execute()

Get a credential by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsCredIdGet(context.Background(), credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsCredIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1CredentialsCredIdGet`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1CredentialsCredIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsCredIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsCredIdPatch

> Credential ApiAmbientV1CredentialsCredIdPatch(ctx, credId).CredentialPatchRequest(credentialPatchRequest).Execute()

Update a credential

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	credId := "credId_example" // string | The id of the credential
	credentialPatchRequest := *openapiclient.NewCredentialPatchRequest() // CredentialPatchRequest | Updated credential data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsCredIdPatch(context.Background(), credId).CredentialPatchRequest(credentialPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsCredIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1CredentialsCredIdPatch`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1CredentialsCredIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsCredIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **credentialPatchRequest** | [**CredentialPatchRequest**](CredentialPatchRequest.md) | Updated credential data | 

### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsCredIdTokenGet

> CredentialTokenResponse ApiAmbientV1CredentialsCredIdTokenGet(ctx, credId).Execute()

Get a decrypted token for a credential



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsCredIdTokenGet(context.Background(), credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsCredIdTokenGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1CredentialsCredIdTokenGet`: CredentialTokenResponse
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1CredentialsCredIdTokenGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsCredIdTokenGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**CredentialTokenResponse**](CredentialTokenResponse.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsGet

> CredentialList ApiAmbientV1CredentialsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Provider(provider).Execute()

Returns a list of credentials

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)
	provider := "provider_example" // string | Filter credentials by provider (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Provider(provider).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1CredentialsGet`: CredentialList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1CredentialsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 
 **provider** | **string** | Filter credentials by provider | 

### Return type

[**CredentialList**](CredentialList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1CredentialsPost

> Credential ApiAmbientV1CredentialsPost(ctx).Credential(credential).Execute()

Create a new credential

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	credential := *openapiclient.NewCredential("Name_example", "Provider_example") // Credential | Credential data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1CredentialsPost(context.Background()).Credential(credential).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1CredentialsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1CredentialsPost`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1CredentialsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1CredentialsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **credential** | [**Credential**](Credential.md) | Credential data | 

### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectSettingsGet

> ProjectSettingsList ApiAmbientV1ProjectSettingsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of project settings

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectSettingsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectSettingsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectSettingsGet`: ProjectSettingsList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectSettingsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectSettingsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**ProjectSettingsList**](ProjectSettingsList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectSettingsIdDelete

> ApiAmbientV1ProjectSettingsIdDelete(ctx, id).Execute()

Delete a project settings by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectSettingsIdDelete(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectSettingsIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectSettingsIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectSettingsIdGet

> ProjectSettings ApiAmbientV1ProjectSettingsIdGet(ctx, id).Execute()

Get a project settings by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectSettingsIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectSettingsIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectSettingsIdGet`: ProjectSettings
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectSettingsIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectSettingsIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**ProjectSettings**](ProjectSettings.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectSettingsIdPatch

> ProjectSettings ApiAmbientV1ProjectSettingsIdPatch(ctx, id).ProjectSettingsPatchRequest(projectSettingsPatchRequest).Execute()

Update a project settings

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	projectSettingsPatchRequest := *openapiclient.NewProjectSettingsPatchRequest() // ProjectSettingsPatchRequest | Updated project settings data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectSettingsIdPatch(context.Background(), id).ProjectSettingsPatchRequest(projectSettingsPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectSettingsIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectSettingsIdPatch`: ProjectSettings
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectSettingsIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectSettingsIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **projectSettingsPatchRequest** | [**ProjectSettingsPatchRequest**](ProjectSettingsPatchRequest.md) | Updated project settings data | 

### Return type

[**ProjectSettings**](ProjectSettings.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectSettingsPost

> ProjectSettings ApiAmbientV1ProjectSettingsPost(ctx).ProjectSettings(projectSettings).Execute()

Create a new project settings

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	projectSettings := *openapiclient.NewProjectSettings("ProjectId_example") // ProjectSettings | Project settings data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectSettingsPost(context.Background()).ProjectSettings(projectSettings).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectSettingsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectSettingsPost`: ProjectSettings
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectSettingsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectSettingsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **projectSettings** | [**ProjectSettings**](ProjectSettings.md) | Project settings data | 

### Return type

[**ProjectSettings**](ProjectSettings.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsGet

> ProjectList ApiAmbientV1ProjectsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of projects

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsGet`: ProjectList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**ProjectList**](ProjectList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdDelete

> ApiAmbientV1ProjectsIdAgentsAgentIdDelete(ctx, id, agentId).Execute()

Delete an agent from a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdDelete(context.Background(), id, agentId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdGet

> Agent ApiAmbientV1ProjectsIdAgentsAgentIdGet(ctx, id, agentId).Execute()

Get an agent by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdGet(context.Background(), id, agentId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdGet`: Agent
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Agent**](Agent.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet

> StartResponse ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet(ctx, id, agentId).Execute()

Preview start context (dry run — no session created)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet(context.Background(), id, agentId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet`: StartResponse
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdIgnitionGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**StartResponse**](StartResponse.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet

> InboxMessageList ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet(ctx, id, agentId).Page(page).Size(size).Execute()

Read inbox messages for an agent (unread first)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet(context.Background(), id, agentId).Page(page).Size(size).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet`: InboxMessageList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdInboxGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]

### Return type

[**InboxMessageList**](InboxMessageList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete

> ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete(ctx, id, agentId, msgId).Execute()

Delete an inbox message

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	msgId := "msgId_example" // string | The id of the inbox message

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete(context.Background(), id, agentId, msgId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 
**msgId** | **string** | The id of the inbox message | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------




### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch

> InboxMessage ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch(ctx, id, agentId, msgId).InboxMessagePatchRequest(inboxMessagePatchRequest).Execute()

Mark an inbox message as read

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	msgId := "msgId_example" // string | The id of the inbox message
	inboxMessagePatchRequest := *openapiclient.NewInboxMessagePatchRequest() // InboxMessagePatchRequest | Inbox message patch

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch(context.Background(), id, agentId, msgId).InboxMessagePatchRequest(inboxMessagePatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch`: InboxMessage
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 
**msgId** | **string** | The id of the inbox message | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdInboxMsgIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



 **inboxMessagePatchRequest** | [**InboxMessagePatchRequest**](InboxMessagePatchRequest.md) | Inbox message patch | 

### Return type

[**InboxMessage**](InboxMessage.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost

> InboxMessage ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost(ctx, id, agentId).InboxMessage(inboxMessage).Execute()

Send a message to an agent's inbox

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	inboxMessage := *openapiclient.NewInboxMessage("AgentId_example", "Body_example") // InboxMessage | Inbox message to send

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost(context.Background(), id, agentId).InboxMessage(inboxMessage).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost`: InboxMessage
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdInboxPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdInboxPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **inboxMessage** | [**InboxMessage**](InboxMessage.md) | Inbox message to send | 

### Return type

[**InboxMessage**](InboxMessage.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdPatch

> Agent ApiAmbientV1ProjectsIdAgentsAgentIdPatch(ctx, id, agentId).AgentPatchRequest(agentPatchRequest).Execute()

Update an agent (name, prompt, labels, annotations)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	agentPatchRequest := *openapiclient.NewAgentPatchRequest() // AgentPatchRequest | Updated agent data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdPatch(context.Background(), id, agentId).AgentPatchRequest(agentPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdPatch`: Agent
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **agentPatchRequest** | [**AgentPatchRequest**](AgentPatchRequest.md) | Updated agent data | 

### Return type

[**Agent**](Agent.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet

> AgentSessionList ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet(ctx, id, agentId).Page(page).Size(size).Execute()

Get session run history for an agent

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet(context.Background(), id, agentId).Page(page).Size(size).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet`: AgentSessionList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdSessionsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdSessionsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]

### Return type

[**AgentSessionList**](AgentSessionList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsAgentIdStartPost

> StartResponse ApiAmbientV1ProjectsIdAgentsAgentIdStartPost(ctx, id, agentId).StartRequest(startRequest).Execute()

Start an agent — creates a Session (idempotent)



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agentId := "agentId_example" // string | The id of the agent
	startRequest := *openapiclient.NewStartRequest() // StartRequest | Optional start parameters (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdStartPost(context.Background(), id, agentId).StartRequest(startRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdStartPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsAgentIdStartPost`: StartResponse
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsAgentIdStartPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**agentId** | **string** | The id of the agent | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsAgentIdStartPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **startRequest** | [**StartRequest**](StartRequest.md) | Optional start parameters | 

### Return type

[**StartResponse**](StartResponse.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsGet

> AgentList ApiAmbientV1ProjectsIdAgentsGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of agents in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsGet`: AgentList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**AgentList**](AgentList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdAgentsPost

> Agent ApiAmbientV1ProjectsIdAgentsPost(ctx, id).Agent(agent).Execute()

Create an agent in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	agent := *openapiclient.NewAgent("ProjectId_example", "Name_example") // Agent | Agent data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdAgentsPost(context.Background(), id).Agent(agent).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdAgentsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdAgentsPost`: Agent
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdAgentsPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdAgentsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **agent** | [**Agent**](Agent.md) | Agent data | 

### Return type

[**Agent**](Agent.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsCredIdDelete

> ApiAmbientV1ProjectsIdCredentialsCredIdDelete(ctx, id, credId).Execute()

Delete a project credential

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdDelete(context.Background(), id, credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsCredIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsCredIdGet

> Credential ApiAmbientV1ProjectsIdCredentialsCredIdGet(ctx, id, credId).Execute()

Get a project credential by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdGet(context.Background(), id, credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdCredentialsCredIdGet`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsCredIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsCredIdPatch

> Credential ApiAmbientV1ProjectsIdCredentialsCredIdPatch(ctx, id, credId).CredentialPatchRequest(credentialPatchRequest).Execute()

Update a project credential

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	credId := "credId_example" // string | The id of the credential
	credentialPatchRequest := *openapiclient.NewCredentialPatchRequest() // CredentialPatchRequest | Updated credential data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdPatch(context.Background(), id, credId).CredentialPatchRequest(credentialPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdCredentialsCredIdPatch`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsCredIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **credentialPatchRequest** | [**CredentialPatchRequest**](CredentialPatchRequest.md) | Updated credential data | 

### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet

> CredentialTokenResponse ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet(ctx, id, credId).Execute()

Get a decrypted token for a project credential



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	credId := "credId_example" // string | The id of the credential

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet(context.Background(), id, credId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet`: CredentialTokenResponse
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsCredIdTokenGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**credId** | **string** | The id of the credential | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsCredIdTokenGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**CredentialTokenResponse**](CredentialTokenResponse.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsGet

> CredentialList ApiAmbientV1ProjectsIdCredentialsGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Provider(provider).Execute()

Returns a list of credentials for a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)
	provider := "provider_example" // string | Filter credentials by provider (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Provider(provider).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdCredentialsGet`: CredentialList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 
 **provider** | **string** | Filter credentials by provider | 

### Return type

[**CredentialList**](CredentialList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdCredentialsPost

> Credential ApiAmbientV1ProjectsIdCredentialsPost(ctx, id).Credential(credential).Execute()

Create a new credential in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	credential := *openapiclient.NewCredential("Name_example", "Provider_example") // Credential | Credential data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdCredentialsPost(context.Background(), id).Credential(credential).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdCredentialsPost`: Credential
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdCredentialsPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdCredentialsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **credential** | [**Credential**](Credential.md) | Credential data | 

### Return type

[**Credential**](Credential.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdDelete

> ApiAmbientV1ProjectsIdDelete(ctx, id).Execute()

Delete a project by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdDelete(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete

> ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete(ctx, id, gatewayId).Execute()

Delete a gateway

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	gatewayId := "gatewayId_example" // string | The id of the gateway

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete(context.Background(), id, gatewayId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**gatewayId** | **string** | The id of the gateway | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGatewaysGatewayIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGatewaysGatewayIdGet

> Gateway ApiAmbientV1ProjectsIdGatewaysGatewayIdGet(ctx, id, gatewayId).Execute()

Get a gateway by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	gatewayId := "gatewayId_example" // string | The id of the gateway

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdGet(context.Background(), id, gatewayId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdGatewaysGatewayIdGet`: Gateway
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**gatewayId** | **string** | The id of the gateway | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGatewaysGatewayIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Gateway**](Gateway.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch

> Gateway ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch(ctx, id, gatewayId).GatewayPatchRequest(gatewayPatchRequest).Execute()

Update a gateway

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	gatewayId := "gatewayId_example" // string | The id of the gateway
	gatewayPatchRequest := *openapiclient.NewGatewayPatchRequest() // GatewayPatchRequest | Updated gateway data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch(context.Background(), id, gatewayId).GatewayPatchRequest(gatewayPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch`: Gateway
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGatewayIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**gatewayId** | **string** | The id of the gateway | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGatewaysGatewayIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **gatewayPatchRequest** | [**GatewayPatchRequest**](GatewayPatchRequest.md) | Updated gateway data | 

### Return type

[**Gateway**](Gateway.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGatewaysGet

> GatewayList ApiAmbientV1ProjectsIdGatewaysGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of gateways for a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdGatewaysGet`: GatewayList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGatewaysGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**GatewayList**](GatewayList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGatewaysPost

> Gateway ApiAmbientV1ProjectsIdGatewaysPost(ctx, id).Gateway(gateway).Execute()

Create a new gateway in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	gateway := *openapiclient.NewGateway("Name_example", "ProjectId_example", []string{"ServerDnsNames_example"}) // Gateway | Gateway data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGatewaysPost(context.Background(), id).Gateway(gateway).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdGatewaysPost`: Gateway
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdGatewaysPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGatewaysPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **gateway** | [**Gateway**](Gateway.md) | Gateway data | 

### Return type

[**Gateway**](Gateway.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdGet

> Project ApiAmbientV1ProjectsIdGet(ctx, id).Execute()

Get a project by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdGet`: Project
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Project**](Project.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdHomeGet

> ProjectHome ApiAmbientV1ProjectsIdHomeGet(ctx, id).Execute()

Project home — latest status for every Agent in this project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdHomeGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdHomeGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdHomeGet`: ProjectHome
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdHomeGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdHomeGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**ProjectHome**](ProjectHome.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPatch

> Project ApiAmbientV1ProjectsIdPatch(ctx, id).ProjectPatchRequest(projectPatchRequest).Execute()

Update a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	projectPatchRequest := *openapiclient.NewProjectPatchRequest() // ProjectPatchRequest | Updated project data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPatch(context.Background(), id).ProjectPatchRequest(projectPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdPatch`: Project
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **projectPatchRequest** | [**ProjectPatchRequest**](ProjectPatchRequest.md) | Updated project data | 

### Return type

[**Project**](Project.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPoliciesGet

> PolicyList ApiAmbientV1ProjectsIdPoliciesGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of policies in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPoliciesGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdPoliciesGet`: PolicyList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPoliciesGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**PolicyList**](PolicyList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete

> ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete(ctx, id, policyId).Execute()

Delete a policy from a project (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	policyId := "policyId_example" // string | The id of the policy

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete(context.Background(), id, policyId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**policyId** | **string** | The id of the policy | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPoliciesPolicyIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPoliciesPolicyIdGet

> Policy ApiAmbientV1ProjectsIdPoliciesPolicyIdGet(ctx, id, policyId).Execute()

Get a policy by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	policyId := "policyId_example" // string | The id of the policy

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdGet(context.Background(), id, policyId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdPoliciesPolicyIdGet`: Policy
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**policyId** | **string** | The id of the policy | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPoliciesPolicyIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Policy**](Policy.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch

> Policy ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch(ctx, id, policyId).PolicyPatchRequest(policyPatchRequest).Execute()

Update a policy (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	policyId := "policyId_example" // string | The id of the policy
	policyPatchRequest := *openapiclient.NewPolicyPatchRequest() // PolicyPatchRequest | Updated policy data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch(context.Background(), id, policyId).PolicyPatchRequest(policyPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch`: Policy
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPolicyIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**policyId** | **string** | The id of the policy | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPoliciesPolicyIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **policyPatchRequest** | [**PolicyPatchRequest**](PolicyPatchRequest.md) | Updated policy data | 

### Return type

[**Policy**](Policy.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdPoliciesPost

> Policy ApiAmbientV1ProjectsIdPoliciesPost(ctx, id).Policy(policy).Execute()

Create a policy in a project (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	policy := *openapiclient.NewPolicy("ProjectId_example", "Name_example") // Policy | Policy data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPost(context.Background(), id).Policy(policy).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdPoliciesPost`: Policy
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdPoliciesPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdPoliciesPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **policy** | [**Policy**](Policy.md) | Policy data | 

### Return type

[**Policy**](Policy.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdProvidersGet

> ProviderList ApiAmbientV1ProjectsIdProvidersGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of providers in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdProvidersGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdProvidersGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdProvidersGet`: ProviderList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdProvidersGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdProvidersGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**ProviderList**](ProviderList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdProvidersPost

> Provider ApiAmbientV1ProjectsIdProvidersPost(ctx, id).Provider(provider).Execute()

Create a provider in a project (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	provider := *openapiclient.NewProvider("ProjectId_example", "Name_example") // Provider | Provider data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdProvidersPost(context.Background(), id).Provider(provider).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdProvidersPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdProvidersPost`: Provider
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdProvidersPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdProvidersPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **provider** | [**Provider**](Provider.md) | Provider data | 

### Return type

[**Provider**](Provider.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdProvidersProviderIdDelete

> ApiAmbientV1ProjectsIdProvidersProviderIdDelete(ctx, id, providerId).Execute()

Delete a provider from a project (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	providerId := "providerId_example" // string | The id of the provider

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdDelete(context.Background(), id, providerId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**providerId** | **string** | The id of the provider | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdProvidersProviderIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdProvidersProviderIdGet

> Provider ApiAmbientV1ProjectsIdProvidersProviderIdGet(ctx, id, providerId).Execute()

Get a provider by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	providerId := "providerId_example" // string | The id of the provider

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdGet(context.Background(), id, providerId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdProvidersProviderIdGet`: Provider
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**providerId** | **string** | The id of the provider | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdProvidersProviderIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Provider**](Provider.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdProvidersProviderIdPatch

> Provider ApiAmbientV1ProjectsIdProvidersProviderIdPatch(ctx, id, providerId).ProviderPatchRequest(providerPatchRequest).Execute()

Update a provider (internal — used by control plane reconciler)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	providerId := "providerId_example" // string | The id of the provider
	providerPatchRequest := *openapiclient.NewProviderPatchRequest() // ProviderPatchRequest | Updated provider data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdPatch(context.Background(), id, providerId).ProviderPatchRequest(providerPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdProvidersProviderIdPatch`: Provider
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdProvidersProviderIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**providerId** | **string** | The id of the provider | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdProvidersProviderIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **providerPatchRequest** | [**ProviderPatchRequest**](ProviderPatchRequest.md) | Updated provider data | 

### Return type

[**Provider**](Provider.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsGet

> ScheduledSessionList ApiAmbientV1ProjectsIdScheduledSessionsGet(ctx, id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of scheduled sessions in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsGet(context.Background(), id).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsGet`: ScheduledSessionList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**ScheduledSessionList**](ScheduledSessionList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsPost

> ScheduledSession ApiAmbientV1ProjectsIdScheduledSessionsPost(ctx, id).ScheduledSession(scheduledSession).Execute()

Create a scheduled session in a project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	scheduledSession := *openapiclient.NewScheduledSession("Name_example", "ProjectId_example", "Schedule_example") // ScheduledSession | Scheduled session data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsPost(context.Background(), id).ScheduledSession(scheduledSession).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsPost`: ScheduledSession
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **scheduledSession** | [**ScheduledSession**](ScheduledSession.md) | Scheduled session data | 

### Return type

[**ScheduledSession**](ScheduledSession.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete

> ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete(ctx, id, ssId).Execute()

Delete a scheduled session

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete(context.Background(), id, ssId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet

> ScheduledSession ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet(ctx, id, ssId).Execute()

Get a scheduled session by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet(context.Background(), id, ssId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet`: ScheduledSession
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**ScheduledSession**](ScheduledSession.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch

> ScheduledSession ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch(ctx, id, ssId).ScheduledSessionPatchRequest(scheduledSessionPatchRequest).Execute()

Update a scheduled session

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session
	scheduledSessionPatchRequest := *openapiclient.NewScheduledSessionPatchRequest() // ScheduledSessionPatchRequest | Updated scheduled session data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch(context.Background(), id, ssId).ScheduledSessionPatchRequest(scheduledSessionPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch`: ScheduledSession
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **scheduledSessionPatchRequest** | [**ScheduledSessionPatchRequest**](ScheduledSessionPatchRequest.md) | Updated scheduled session data | 

### Return type

[**ScheduledSession**](ScheduledSession.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost

> ScheduledSession ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost(ctx, id, ssId).Execute()

Resume a suspended scheduled session (sets enabled=true)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost(context.Background(), id, ssId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost`: ScheduledSession
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdResumePostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**ScheduledSession**](ScheduledSession.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet

> SessionList ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet(ctx, id, ssId).Page(page).Size(size).Execute()

List sessions triggered by this scheduled session

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet(context.Background(), id, ssId).Page(page).Size(size).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet`: SessionList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdRunsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]

### Return type

[**SessionList**](SessionList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost

> ScheduledSession ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost(ctx, id, ssId).Execute()

Suspend a scheduled session (sets enabled=false)

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost(context.Background(), id, ssId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost`: ScheduledSession
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdSuspendPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**ScheduledSession**](ScheduledSession.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost

> Session ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost(ctx, id, ssId).Execute()

Manually trigger a scheduled session to run immediately

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	ssId := "ssId_example" // string | The id of the scheduled session

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost(context.Background(), id, ssId).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 
**ssId** | **string** | The id of the scheduled session | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsIdScheduledSessionsSsIdTriggerPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------



### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1ProjectsPost

> Project ApiAmbientV1ProjectsPost(ctx).Project(project).Execute()

Create a new project

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	project := *openapiclient.NewProject("Name_example") // Project | Project data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1ProjectsPost(context.Background()).Project(project).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1ProjectsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1ProjectsPost`: Project
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1ProjectsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1ProjectsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **project** | [**Project**](Project.md) | Project data | 

### Return type

[**Project**](Project.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RoleBindingsGet

> RoleBindingList ApiAmbientV1RoleBindingsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of roleBindings

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RoleBindingsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RoleBindingsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RoleBindingsGet`: RoleBindingList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RoleBindingsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RoleBindingsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**RoleBindingList**](RoleBindingList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RoleBindingsIdDelete

> ApiAmbientV1RoleBindingsIdDelete(ctx, id).Execute()

Delete a role binding by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1RoleBindingsIdDelete(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RoleBindingsIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RoleBindingsIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RoleBindingsIdGet

> RoleBinding ApiAmbientV1RoleBindingsIdGet(ctx, id).Execute()

Get an roleBinding by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RoleBindingsIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RoleBindingsIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RoleBindingsIdGet`: RoleBinding
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RoleBindingsIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RoleBindingsIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**RoleBinding**](RoleBinding.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RoleBindingsIdPatch

> RoleBinding ApiAmbientV1RoleBindingsIdPatch(ctx, id).RoleBindingPatchRequest(roleBindingPatchRequest).Execute()

Update an roleBinding

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	roleBindingPatchRequest := *openapiclient.NewRoleBindingPatchRequest() // RoleBindingPatchRequest | Updated roleBinding data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RoleBindingsIdPatch(context.Background(), id).RoleBindingPatchRequest(roleBindingPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RoleBindingsIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RoleBindingsIdPatch`: RoleBinding
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RoleBindingsIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RoleBindingsIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **roleBindingPatchRequest** | [**RoleBindingPatchRequest**](RoleBindingPatchRequest.md) | Updated roleBinding data | 

### Return type

[**RoleBinding**](RoleBinding.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RoleBindingsPost

> RoleBinding ApiAmbientV1RoleBindingsPost(ctx).RoleBinding(roleBinding).Execute()

Create a new roleBinding

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	roleBinding := *openapiclient.NewRoleBinding("RoleId_example", "Scope_example") // RoleBinding | RoleBinding data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RoleBindingsPost(context.Background()).RoleBinding(roleBinding).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RoleBindingsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RoleBindingsPost`: RoleBinding
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RoleBindingsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RoleBindingsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **roleBinding** | [**RoleBinding**](RoleBinding.md) | RoleBinding data | 

### Return type

[**RoleBinding**](RoleBinding.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RolesGet

> RoleList ApiAmbientV1RolesGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of roles

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RolesGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RolesGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RolesGet`: RoleList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RolesGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RolesGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**RoleList**](RoleList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RolesIdDelete

> ApiAmbientV1RolesIdDelete(ctx, id).Execute()

Delete a role by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1RolesIdDelete(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RolesIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RolesIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RolesIdGet

> Role ApiAmbientV1RolesIdGet(ctx, id).Execute()

Get an role by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RolesIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RolesIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RolesIdGet`: Role
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RolesIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RolesIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Role**](Role.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RolesIdPatch

> Role ApiAmbientV1RolesIdPatch(ctx, id).RolePatchRequest(rolePatchRequest).Execute()

Update an role

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	rolePatchRequest := *openapiclient.NewRolePatchRequest() // RolePatchRequest | Updated role data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RolesIdPatch(context.Background(), id).RolePatchRequest(rolePatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RolesIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RolesIdPatch`: Role
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RolesIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RolesIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **rolePatchRequest** | [**RolePatchRequest**](RolePatchRequest.md) | Updated role data | 

### Return type

[**Role**](Role.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1RolesPost

> Role ApiAmbientV1RolesPost(ctx).Role(role).Execute()

Create a new role

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	role := *openapiclient.NewRole("Name_example") // Role | Role data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1RolesPost(context.Background()).Role(role).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1RolesPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1RolesPost`: Role
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1RolesPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1RolesPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **role** | [**Role**](Role.md) | Role data | 

### Return type

[**Role**](Role.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsGet

> SessionList ApiAmbientV1SessionsGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of sessions

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsGet`: SessionList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**SessionList**](SessionList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdDelete

> ApiAmbientV1SessionsIdDelete(ctx, id).Execute()

Delete a session by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdDelete(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdDelete``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdDeleteRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

 (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdEventsGet

> string ApiAmbientV1SessionsIdEventsGet(ctx, id).Execute()

Stream live AG-UI events from the runner pod



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdEventsGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdEventsGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdEventsGet`: string
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdEventsGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdEventsGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: text/event-stream, application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdEventsHistoryGet

> SessionEventList ApiAmbientV1SessionsIdEventsHistoryGet(ctx, id).AfterSeq(afterSeq).EventType(eventType).Limit(limit).StartTime(startTime).EndTime(endTime).Execute()

List persisted compressed AG-UI events



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
    "time"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	afterSeq := int64(789) // int64 | Return only events with seq greater than this value (for replay/catch-up) (optional) (default to 0)
	eventType := "eventType_example" // string | Filter by AG-UI event type (e.g. TEXT_MESSAGE_CONTENT, TOOL_CALL_START) (optional)
	limit := int32(56) // int32 | Max events to return (default 100, max 1000) (optional) (default to 100)
	startTime := time.Now() // time.Time | Filter events created after this timestamp (ISO 8601) (optional)
	endTime := time.Now() // time.Time | Filter events created before this timestamp (ISO 8601) (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdEventsHistoryGet(context.Background(), id).AfterSeq(afterSeq).EventType(eventType).Limit(limit).StartTime(startTime).EndTime(endTime).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdEventsHistoryGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdEventsHistoryGet`: SessionEventList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdEventsHistoryGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdEventsHistoryGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **afterSeq** | **int64** | Return only events with seq greater than this value (for replay/catch-up) | [default to 0]
 **eventType** | **string** | Filter by AG-UI event type (e.g. TEXT_MESSAGE_CONTENT, TOOL_CALL_START) | 
 **limit** | **int32** | Max events to return (default 100, max 1000) | [default to 100]
 **startTime** | **time.Time** | Filter events created after this timestamp (ISO 8601) | 
 **endTime** | **time.Time** | Filter events created before this timestamp (ISO 8601) | 

### Return type

[**SessionEventList**](SessionEventList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdGet

> Session ApiAmbientV1SessionsIdGet(ctx, id).Execute()

Get an session by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdGet`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdMessagesGet

> []SessionMessage ApiAmbientV1SessionsIdMessagesGet(ctx, id).AfterSeq(afterSeq).Execute()

List or stream session messages



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	afterSeq := int64(789) // int64 | Return only messages with seq greater than this value (default 0 = all messages) (optional) (default to 0)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdMessagesGet(context.Background(), id).AfterSeq(afterSeq).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdMessagesGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdMessagesGet`: []SessionMessage
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdMessagesGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdMessagesGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **afterSeq** | **int64** | Return only messages with seq greater than this value (default 0 &#x3D; all messages) | [default to 0]

### Return type

[**[]SessionMessage**](SessionMessage.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json, text/event-stream

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdMessagesPost

> SessionMessage ApiAmbientV1SessionsIdMessagesPost(ctx, id).SessionMessagePushRequest(sessionMessagePushRequest).Execute()

Push a message to a session



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	sessionMessagePushRequest := *openapiclient.NewSessionMessagePushRequest() // SessionMessagePushRequest | 

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdMessagesPost(context.Background(), id).SessionMessagePushRequest(sessionMessagePushRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdMessagesPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdMessagesPost`: SessionMessage
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdMessagesPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdMessagesPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **sessionMessagePushRequest** | [**SessionMessagePushRequest**](SessionMessagePushRequest.md) |  | 

### Return type

[**SessionMessage**](SessionMessage.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdPatch

> Session ApiAmbientV1SessionsIdPatch(ctx, id).SessionPatchRequest(sessionPatchRequest).Execute()

Update an session

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	sessionPatchRequest := *openapiclient.NewSessionPatchRequest() // SessionPatchRequest | Updated session data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdPatch(context.Background(), id).SessionPatchRequest(sessionPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdPatch`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **sessionPatchRequest** | [**SessionPatchRequest**](SessionPatchRequest.md) | Updated session data | 

### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdStartPost

> Session ApiAmbientV1SessionsIdStartPost(ctx, id).Execute()

Start a session



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdStartPost(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdStartPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdStartPost`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdStartPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdStartPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdStatusPatch

> Session ApiAmbientV1SessionsIdStatusPatch(ctx, id).SessionStatusPatchRequest(sessionStatusPatchRequest).Execute()

Update session status fields



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	sessionStatusPatchRequest := *openapiclient.NewSessionStatusPatchRequest() // SessionStatusPatchRequest | Session status fields to update

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdStatusPatch(context.Background(), id).SessionStatusPatchRequest(sessionStatusPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdStatusPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdStatusPatch`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdStatusPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdStatusPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **sessionStatusPatchRequest** | [**SessionStatusPatchRequest**](SessionStatusPatchRequest.md) | Session status fields to update | 

### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsIdStopPost

> Session ApiAmbientV1SessionsIdStopPost(ctx, id).Execute()

Stop a session



### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsIdStopPost(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsIdStopPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsIdStopPost`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsIdStopPost`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsIdStopPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1SessionsPost

> Session ApiAmbientV1SessionsPost(ctx).Session(session).Execute()

Create a new session

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	session := *openapiclient.NewSession("Name_example") // Session | Session data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1SessionsPost(context.Background()).Session(session).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1SessionsPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1SessionsPost`: Session
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1SessionsPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1SessionsPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **session** | [**Session**](Session.md) | Session data | 

### Return type

[**Session**](Session.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1UsersGet

> UserList ApiAmbientV1UsersGet(ctx).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()

Returns a list of users

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	page := int32(56) // int32 | Page number of record list when record list exceeds specified page size (optional) (default to 1)
	size := int32(56) // int32 | Maximum number of records to return (optional) (default to 100)
	search := "search_example" // string | Specifies the search criteria (optional)
	orderBy := "orderBy_example" // string | Specifies the order by criteria (optional)
	fields := "fields_example" // string | Supplies a comma-separated list of fields to be returned (optional)

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1UsersGet(context.Background()).Page(page).Size(size).Search(search).OrderBy(orderBy).Fields(fields).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1UsersGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1UsersGet`: UserList
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1UsersGet`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1UsersGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **page** | **int32** | Page number of record list when record list exceeds specified page size | [default to 1]
 **size** | **int32** | Maximum number of records to return | [default to 100]
 **search** | **string** | Specifies the search criteria | 
 **orderBy** | **string** | Specifies the order by criteria | 
 **fields** | **string** | Supplies a comma-separated list of fields to be returned | 

### Return type

[**UserList**](UserList.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1UsersIdGet

> User ApiAmbientV1UsersIdGet(ctx, id).Execute()

Get an user by id

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1UsersIdGet(context.Background(), id).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1UsersIdGet``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1UsersIdGet`: User
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1UsersIdGet`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1UsersIdGetRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------


### Return type

[**User**](User.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1UsersIdPatch

> User ApiAmbientV1UsersIdPatch(ctx, id).UserPatchRequest(userPatchRequest).Execute()

Update an user

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	id := "id_example" // string | The id of record
	userPatchRequest := *openapiclient.NewUserPatchRequest() // UserPatchRequest | Updated user data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1UsersIdPatch(context.Background(), id).UserPatchRequest(userPatchRequest).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1UsersIdPatch``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1UsersIdPatch`: User
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1UsersIdPatch`: %v\n", resp)
}
```

### Path Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
**ctx** | **context.Context** | context for authentication, logging, cancellation, deadlines, tracing, etc.
**id** | **string** | The id of record | 

### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1UsersIdPatchRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------

 **userPatchRequest** | [**UserPatchRequest**](UserPatchRequest.md) | Updated user data | 

### Return type

[**User**](User.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)


## ApiAmbientV1UsersPost

> User ApiAmbientV1UsersPost(ctx).User(user).Execute()

Create a new user

### Example

```go
package main

import (
	"context"
	"fmt"
	"os"
	openapiclient "github.com/GIT_USER_ID/GIT_REPO_ID"
)

func main() {
	user := *openapiclient.NewUser("Username_example", "Name_example") // User | User data

	configuration := openapiclient.NewConfiguration()
	apiClient := openapiclient.NewAPIClient(configuration)
	resp, r, err := apiClient.DefaultAPI.ApiAmbientV1UsersPost(context.Background()).User(user).Execute()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error when calling `DefaultAPI.ApiAmbientV1UsersPost``: %v\n", err)
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", r)
	}
	// response from `ApiAmbientV1UsersPost`: User
	fmt.Fprintf(os.Stdout, "Response from `DefaultAPI.ApiAmbientV1UsersPost`: %v\n", resp)
}
```

### Path Parameters



### Other Parameters

Other parameters are passed through a pointer to a apiApiAmbientV1UsersPostRequest struct via the builder pattern


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **user** | [**User**](User.md) | User data | 

### Return type

[**User**](User.md)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints)
[[Back to Model list]](../README.md#documentation-for-models)
[[Back to README]](../README.md)

