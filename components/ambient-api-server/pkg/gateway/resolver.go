package gateway

import (
	"sync"

	"github.com/golang/glog"
)

var (
	globalResolver *TierResolver
	resolverOnce   sync.Once
)

// GetTierResolver returns the singleton TierResolver instance.
// Initialized once at first call.
func GetTierResolver() *TierResolver {
	resolverOnce.Do(func() {
		var err error
		globalResolver, err = NewTierResolver()
		if err != nil {
			glog.Errorf("Failed to initialize TierResolver: %v", err)
			globalResolver = &TierResolver{enabled: false}
		}
	})
	return globalResolver
}
