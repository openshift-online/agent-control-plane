package views

import (
	"time"

	"github.com/charmbracelet/bubbles/table"

	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

func CredentialBindingColumns() []table.Column {
	return []table.Column{
		{Title: "CREDENTIAL", Width: 20},
		{Title: "TYPE", Width: 8},
		{Title: "TARGET", Width: 20},
		{Title: "STATE", Width: 12},
		{Title: "AGE", Width: 8},
	}
}

// CredentialBindingRow builds a table row for a credential binding.
// For direct bindings, pass the RoleBinding and state="direct".
// For inherited rows (synthesized), pass state="inherited" and age will be empty.
func CredentialBindingRow(b sdktypes.RoleBinding, credName string, targetType string, targetName string, state string, now time.Time) table.Row {
	age := ""
	if state == "direct" && b.CreatedAt != nil {
		age = FormatAge(now.Sub(*b.CreatedAt))
	}

	return table.Row{
		credName,
		targetType,
		targetName,
		state,
		age,
	}
}

func NewCredentialBindingTable(scope string, style TableStyle) ResourceTable {
	return NewResourceTable("credentialbindings", scope, CredentialBindingColumns(), style)
}
