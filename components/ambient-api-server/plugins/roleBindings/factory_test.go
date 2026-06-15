package roleBindings_test

import (
	"context"
	"fmt"

	"github.com/ambient-code/platform/components/ambient-api-server/plugins/roleBindings"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

// ensureBuiltInRoles re-seeds the built-in roles after ResetDB truncates all
// tables. Without this, role lookups in the handler's escalation-prevention
// code fail with "target role not found".
func ensureBuiltInRoles() {
	g := environments.Environment().Database.SessionFactory.New(context.Background())
	roles := []struct {
		name string
		perm string
	}{
		{"platform:admin", `["*:*"]`},
		{"platform:viewer", `["project:read","project:list","session:read","session:list","agent:read","agent:list"]`},
		{"project:owner", `["project:read","project:update","project:delete","agent:*","session:*","session_message:*","role_binding:*"]`},
		{"project:editor", `["project:read","agent:create","agent:read","agent:update","agent:list","agent:start","session:create","session:read","session:update","session:list","session_message:*","role_binding:delete"]`},
		{"project:viewer", `["project:read","agent:read","agent:list","session:read","session:list","session_message:read","session_message:list"]`},
		{"agent:operator", `["agent:read","agent:update","agent:start","agent:list","session:read","session:list"]`},
		{"agent:observer", `["agent:read","agent:list","session:read","session:list"]`},
		{"agent:runner", `["session:read","session_message:*"]`},
	}
	for _, r := range roles {
		g.Exec(
			`INSERT INTO roles (id, name, display_name, description, permissions, built_in, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, true, NOW(), NOW())
			 ON CONFLICT (name) DO NOTHING`,
			api.NewID(), r.name, r.name, r.name, r.perm,
		)
	}
}

// seedAdminBinding creates a platform:admin role binding for the given username
// so that the handler's RBAC escalation-prevention checks pass.
func seedAdminBinding(username string) {
	g := environments.Environment().Database.SessionFactory.New(context.Background())
	var adminRoleID string
	g.Raw(`SELECT id FROM roles WHERE name = 'platform:admin' AND deleted_at IS NULL`).Scan(&adminRoleID)
	if adminRoleID == "" {
		return
	}
	g.Exec(
		`INSERT INTO role_bindings (id, role_id, scope, user_id, created_at, updated_at)
		 VALUES (?, ?, 'global', ?, NOW(), NOW())
		 ON CONFLICT DO NOTHING`,
		api.NewID(), adminRoleID, username,
	)
}

// lookupRoleID returns the DB ID for a role by name.
func lookupRoleID(name string) string {
	g := environments.Environment().Database.SessionFactory.New(context.Background())
	var id string
	g.Raw(`SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL`, name).Scan(&id)
	return id
}

func newRoleBinding(userID string) (*roleBindings.RoleBinding, error) {
	roleBindingService := roleBindings.Service(&environments.Environment().Services)

	roleID := lookupRoleID("project:viewer")
	if roleID == "" {
		return nil, fmt.Errorf("project:viewer role not found; call ensureBuiltInRoles first")
	}

	roleBinding := &roleBindings.RoleBinding{
		UserId: stringPtr(userID),
		RoleId: roleID,
		Scope:  "project",
	}

	sub, err := roleBindingService.Create(context.Background(), roleBinding)
	if err != nil {
		return nil, err
	}

	return sub, nil
}

func newRoleBindingList(namePrefix string, count int) ([]*roleBindings.RoleBinding, error) {
	var items []*roleBindings.RoleBinding
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		c, err := newRoleBinding(name)
		if err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, nil
}
func stringPtr(s string) *string { return &s }
