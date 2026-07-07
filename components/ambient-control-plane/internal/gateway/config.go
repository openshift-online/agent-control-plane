package gateway

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog/log"
	"gopkg.in/yaml.v3"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// NamespaceConfig represents a single namespace entry from platform-config
type NamespaceConfig struct {
	Name    string        `yaml:"name"`
	Gateway GatewayConfig `yaml:"gateway"`
}

// GatewayConfig contains gateway-specific configuration for a namespace
type GatewayConfig struct {
	Image          string   `yaml:"image"`
	ServerDnsNames []string `yaml:"serverDnsNames"`
	Config         string   `yaml:"config"` // TOML content
}

// LoadPlatformConfig reads platform-config ConfigMap from ACP namespace
// Returns namespace configs and the ConfigMap itself (for OwnerReferences)
func LoadPlatformConfig(ctx context.Context, clientset *kubernetes.Clientset, namespace string) ([]NamespaceConfig, *v1.ConfigMap, error) {
	cm, err := clientset.CoreV1().ConfigMaps(namespace).Get(ctx, "platform-config", metav1.GetOptions{})
	if err != nil {
		log.Error().
			Str("configmap", "platform-config").
			Str("namespace", namespace).
			Err(err).
			Msg("failed to load platform-config ConfigMap")
		return []NamespaceConfig{}, nil, fmt.Errorf("load platform-config: %w", err)
	}

	namespacesYAML, ok := cm.Data["namespaces"]
	if !ok {
		log.Error().
			Str("configmap", "platform-config").
			Msg("platform-config missing 'namespaces' key")
		return []NamespaceConfig{}, nil, fmt.Errorf("platform-config missing 'namespaces' key")
	}

	var namespaces []NamespaceConfig
	if err := yaml.Unmarshal([]byte(namespacesYAML), &namespaces); err != nil {
		log.Error().
			Str("configmap", "platform-config").
			Err(err).
			Msg("failed to parse platform-config namespaces YAML")
		return []NamespaceConfig{}, nil, fmt.Errorf("parse platform-config: %w", err)
	}

	log.Info().
		Str("configmap", "platform-config").
		Int("namespace_count", len(namespaces)).
		Msg("loaded platform-config")

	return namespaces, cm, nil
}

// WatchPlatformConfig sets up a Kubernetes Informer to watch platform-config ConfigMap changes
func WatchPlatformConfig(ctx context.Context, clientset *kubernetes.Clientset, namespace string, onChange func([]NamespaceConfig, *v1.ConfigMap)) error {
	// Create SharedInformerFactory filtered to specific ConfigMap
	factory := informers.NewSharedInformerFactoryWithOptions(
		clientset,
		30*time.Second,
		informers.WithNamespace(namespace),
		informers.WithTweakListOptions(func(opts *metav1.ListOptions) {
			opts.FieldSelector = "metadata.name=platform-config"
		}),
	)

	cmInformer := factory.Core().V1().ConfigMaps().Informer()

	// Add event handlers for Add and Update
	cmInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			cm := obj.(*v1.ConfigMap)
			log.Info().
				Str("configmap", cm.Name).
				Msg("platform-config added, triggering reconciliation")
			configs := parseConfigMap(cm)
			onChange(configs, cm)
		},
		UpdateFunc: func(oldObj, newObj interface{}) {
			cm := newObj.(*v1.ConfigMap)
			log.Debug().
				Str("configmap", cm.Name).
				Msg("platform-config reconcile triggered")
			configs := parseConfigMap(cm)
			onChange(configs, cm)
		},
		DeleteFunc: func(obj interface{}) {
			cm, ok := obj.(*v1.ConfigMap)
			if !ok {
				tombstone, ok := obj.(cache.DeletedFinalStateUnknown)
				if !ok {
					log.Warn().Msg("platform-config delete: unrecognized object type")
					return
				}
				cm, ok = tombstone.Obj.(*v1.ConfigMap)
				if !ok {
					log.Warn().Msg("platform-config delete: tombstone is not a ConfigMap")
					return
				}
			}
			log.Warn().
				Str("configmap", cm.Name).
				Msg("platform-config deleted, clearing gateway configs")
			onChange([]NamespaceConfig{}, nil)
		},
	})

	log.Info().
		Str("configmap", "platform-config").
		Str("namespace", namespace).
		Msg("starting platform-config Informer (resync every 30s)")

	// Start informer and block until context is cancelled
	factory.Start(ctx.Done())

	// Wait for initial cache sync
	if !cache.WaitForCacheSync(ctx.Done(), cmInformer.HasSynced) {
		return fmt.Errorf("failed to sync platform-config Informer cache")
	}

	log.Info().Msg("platform-config Informer cache synced")

	// Block until context is cancelled
	<-ctx.Done()
	log.Info().Msg("platform-config Informer stopped")
	return ctx.Err()
}

// parseConfigMap extracts namespace configs from a ConfigMap
func parseConfigMap(cm *v1.ConfigMap) []NamespaceConfig {
	namespacesYAML, ok := cm.Data["namespaces"]
	if !ok {
		log.Error().
			Str("configmap", cm.Name).
			Msg("platform-config missing 'namespaces' key")
		return []NamespaceConfig{}
	}

	var namespaces []NamespaceConfig
	if err := yaml.Unmarshal([]byte(namespacesYAML), &namespaces); err != nil {
		log.Error().
			Str("configmap", cm.Name).
			Err(err).
			Msg("failed to parse platform-config namespaces YAML")
		return []NamespaceConfig{}
	}

	log.Debug().
		Str("configmap", cm.Name).
		Int("namespace_count", len(namespaces)).
		Msg("parsed platform-config")

	return namespaces
}
