package views

import (
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/table"

	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

func CredentialColumns() []table.Column {
	return []table.Column{
		{Title: "NAME", Width: 20},
		{Title: "PROVIDER", Width: 12},
		{Title: "DESCRIPTION", Width: 32},
		{Title: "BINDINGS", Width: 10},
		{Title: "AGE", Width: 8},
	}
}

func CredentialRow(c sdktypes.Credential, bindingCount int, now time.Time) table.Row {
	age := ""
	if c.CreatedAt != nil {
		age = FormatAge(now.Sub(*c.CreatedAt))
	}

	bindings := "0"
	if bindingCount > 0 {
		bindings = fmt.Sprintf("%d", bindingCount)
	}

	return table.Row{
		c.Name,
		c.Provider,
		TruncateString(c.Description, 32),
		bindings,
		age,
	}
}

func NewCredentialTable(scope string, style TableStyle) ResourceTable {
	return NewResourceTable("credentials", scope, CredentialColumns(), style)
}
