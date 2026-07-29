package rbac

import (
	"fmt"

	"gorm.io/gorm"
)

// ResolveUserID looks up the KSUID primary key for a username.
// All role_bindings.user_id values must store the users.id KSUID,
// not the username string.
func ResolveUserID(g *gorm.DB, username string) (string, error) {
	var id string
	err := g.Table("users").Select("id").
		Where("username = ? AND deleted_at IS NULL", username).
		Scan(&id).Error
	if err != nil {
		return "", fmt.Errorf("resolve user %q: %w", username, err)
	}
	if id == "" {
		return "", fmt.Errorf("user %q not found", username)
	}
	return id, nil
}
