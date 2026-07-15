package rbac

type Resource string

const (
	ResourceUser            Resource = "user"
	ResourceProject         Resource = "project"
	ResourceProjectSettings Resource = "project_settings"
	ResourceAgent           Resource = "agent"
	ResourceSession         Resource = "session"
	ResourceSessionMessage  Resource = "session_message"
	ResourceSessionEvent    Resource = "session_event"
	ResourceBlackboard      Resource = "blackboard"
	ResourceRole            Resource = "role"
	ResourceRoleBinding     Resource = "role_binding"
	ResourceCredential      Resource = "credential"
	ResourceProvider        Resource = "provider"
	ResourceGateway         Resource = "gateway"
	ResourceCluster         Resource = "cluster"
)

type Action string

const (
	ActionCreate     Action = "create"
	ActionRead       Action = "read"
	ActionUpdate     Action = "update"
	ActionDelete     Action = "delete"
	ActionList       Action = "list"
	ActionWatch      Action = "watch"
	ActionStart      Action = "start"
	ActionCheckin    Action = "checkin"
	ActionMessage    Action = "message"
	ActionFetchToken Action = "fetch_token"
)

type Permission struct {
	Resource Resource
	Action   Action
}

func (p Permission) String() string {
	return string(p.Resource) + ":" + string(p.Action)
}

const (
	RolePlatformAdmin  = "platform:admin"
	RolePlatformViewer = "platform:viewer"

	RoleProjectOwner  = "project:owner"
	RoleProjectEditor = "project:editor"
	RoleProjectViewer = "project:viewer"

	RoleAgentOperator = "agent:operator"
	RoleAgentObserver = "agent:observer"
	RoleAgentRunner   = "agent:runner"

	RoleCredentialOwner       = "credential:owner"
	RoleCredentialReader      = "credential:reader"
	RoleCredentialTokenReader = "credential:token-reader"

	RoleClusterAdmin  = "cluster:admin"
	RoleClusterViewer = "cluster:viewer"
)

var (
	PermUserRead   = Permission{ResourceUser, ActionRead}
	PermUserList   = Permission{ResourceUser, ActionList}
	PermUserCreate = Permission{ResourceUser, ActionCreate}
	PermUserUpdate = Permission{ResourceUser, ActionUpdate}
	PermUserDelete = Permission{ResourceUser, ActionDelete}

	PermProjectCreate = Permission{ResourceProject, ActionCreate}
	PermProjectRead   = Permission{ResourceProject, ActionRead}
	PermProjectUpdate = Permission{ResourceProject, ActionUpdate}
	PermProjectDelete = Permission{ResourceProject, ActionDelete}
	PermProjectList   = Permission{ResourceProject, ActionList}

	PermProjectSettingsRead   = Permission{ResourceProjectSettings, ActionRead}
	PermProjectSettingsUpdate = Permission{ResourceProjectSettings, ActionUpdate}

	PermAgentCreate = Permission{ResourceAgent, ActionCreate}
	PermAgentRead   = Permission{ResourceAgent, ActionRead}
	PermAgentUpdate = Permission{ResourceAgent, ActionUpdate}
	PermAgentDelete = Permission{ResourceAgent, ActionDelete}
	PermAgentList   = Permission{ResourceAgent, ActionList}
	PermAgentStart  = Permission{ResourceAgent, ActionStart}

	PermSessionRead   = Permission{ResourceSession, ActionRead}
	PermSessionList   = Permission{ResourceSession, ActionList}
	PermSessionDelete = Permission{ResourceSession, ActionDelete}

	PermSessionMessageWatch = Permission{ResourceSessionMessage, ActionWatch}

	PermSessionEventList  = Permission{ResourceSessionEvent, ActionList}
	PermSessionEventWatch = Permission{ResourceSessionEvent, ActionWatch}

	PermBlackboardWatch = Permission{ResourceBlackboard, ActionWatch}
	PermBlackboardRead  = Permission{ResourceBlackboard, ActionRead}

	PermRoleRead          = Permission{ResourceRole, ActionRead}
	PermRoleList          = Permission{ResourceRole, ActionList}
	PermRoleCreate        = Permission{ResourceRole, ActionCreate}
	PermRoleUpdate        = Permission{ResourceRole, ActionUpdate}
	PermRoleDelete        = Permission{ResourceRole, ActionDelete}
	PermRoleBindingRead   = Permission{ResourceRoleBinding, ActionRead}
	PermRoleBindingList   = Permission{ResourceRoleBinding, ActionList}
	PermRoleBindingCreate = Permission{ResourceRoleBinding, ActionCreate}
	PermRoleBindingDelete = Permission{ResourceRoleBinding, ActionDelete}

	PermCredentialCreate     = Permission{ResourceCredential, ActionCreate}
	PermCredentialRead       = Permission{ResourceCredential, ActionRead}
	PermCredentialUpdate     = Permission{ResourceCredential, ActionUpdate}
	PermCredentialDelete     = Permission{ResourceCredential, ActionDelete}
	PermCredentialList       = Permission{ResourceCredential, ActionList}
	PermCredentialFetchToken = Permission{ResourceCredential, ActionFetchToken}

	PermProviderCreate = Permission{ResourceProvider, ActionCreate}
	PermProviderRead   = Permission{ResourceProvider, ActionRead}
	PermProviderUpdate = Permission{ResourceProvider, ActionUpdate}
	PermProviderDelete = Permission{ResourceProvider, ActionDelete}
	PermProviderList   = Permission{ResourceProvider, ActionList}

	PermGatewayCreate = Permission{ResourceGateway, ActionCreate}
	PermGatewayRead   = Permission{ResourceGateway, ActionRead}
	PermGatewayUpdate = Permission{ResourceGateway, ActionUpdate}
	PermGatewayDelete = Permission{ResourceGateway, ActionDelete}
	PermGatewayList   = Permission{ResourceGateway, ActionList}

	PermClusterCreate = Permission{ResourceCluster, ActionCreate}
	PermClusterRead   = Permission{ResourceCluster, ActionRead}
	PermClusterUpdate = Permission{ResourceCluster, ActionUpdate}
	PermClusterDelete = Permission{ResourceCluster, ActionDelete}
	PermClusterList   = Permission{ResourceCluster, ActionList}
)
