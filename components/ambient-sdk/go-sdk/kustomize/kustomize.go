package kustomize

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Resource struct {
	Kind           string            `yaml:"kind"`
	Name           string            `yaml:"name"`
	Description    string            `yaml:"description"`
	Prompt         string            `yaml:"prompt"`
	Labels         map[string]string `yaml:"labels"`
	Annotations    map[string]string `yaml:"annotations"`
	Inbox          []InboxSeed       `yaml:"inbox"`
	Providers      []string          `yaml:"providers"`
	Payloads       []PayloadDecl     `yaml:"payloads"`
	Environment    map[string]string `yaml:"environment"`
	Provider       string            `yaml:"provider"`
	Token          string            `yaml:"token"`
	URL            string            `yaml:"url"`
	Email          string            `yaml:"email"`
	Secret         string            `yaml:"secret"`
	Type           string            `yaml:"type"`
	Role           string            `yaml:"role"`
	Scope          string            `yaml:"scope"`
	ScopeID        string            `yaml:"scope_id"`
	UserID         string            `yaml:"user_id"`
	ServerDnsNames []string          `yaml:"server_dns_names"`
	Image          string            `yaml:"image"`
	Config         string            `yaml:"config"`
	Oidc           map[string]any    `yaml:"oidc,omitempty"`
	SandboxPolicy  string            `yaml:"sandbox_policy"`
	Spec           map[string]any    `yaml:"spec"`
}

type PayloadDecl struct {
	SandboxPath string `yaml:"sandbox_path"`
	Content     string `yaml:"content,omitempty"`
	RepoURL     string `yaml:"repo_url,omitempty"`
	Ref         string `yaml:"ref,omitempty"`
}

type InboxSeed struct {
	FromName string `yaml:"from_name"`
	Body     string `yaml:"body"`
}

type kustomization struct {
	Kind      string      `yaml:"kind"`
	Resources []string    `yaml:"resources"`
	Bases     []string    `yaml:"bases"`
	Patches   []kustPatch `yaml:"patches"`
}

type kustPatch struct {
	Path   string     `yaml:"path"`
	Target kustTarget `yaml:"target"`
}

type kustTarget struct {
	Kind string `yaml:"kind"`
	Name string `yaml:"name"`
}

func LoadKustomize(dir string) ([]Resource, error) {
	kustFile := ""
	for _, name := range []string{"kustomization.yaml", "kustomization.yml"} {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			kustFile = p
			break
		}
	}
	if kustFile == "" {
		return nil, fmt.Errorf("no kustomization.yaml found in %s", dir)
	}

	data, err := os.ReadFile(kustFile)
	if err != nil {
		return nil, err
	}
	var kust kustomization
	if err := yaml.Unmarshal(data, &kust); err != nil {
		return nil, fmt.Errorf("parse kustomization: %w", err)
	}

	var docs []Resource

	for _, base := range kust.Bases {
		basePath := filepath.Join(dir, base)
		baseDocs, err := LoadKustomize(basePath)
		if err != nil {
			return nil, fmt.Errorf("base %s: %w", base, err)
		}
		docs = append(docs, baseDocs...)
	}

	for _, res := range kust.Resources {
		resPath := filepath.Join(dir, res)
		info, err := os.Stat(resPath)
		if err != nil {
			return nil, fmt.Errorf("resource %s: %w", res, err)
		}
		var resDocs []Resource
		if info.IsDir() {
			resDocs, err = LoadKustomize(resPath)
		} else {
			resDocs, err = LoadFile(resPath)
		}
		if err != nil {
			return nil, fmt.Errorf("resource %s: %w", res, err)
		}
		docs = MergeResources(docs, resDocs)
	}

	for _, patch := range kust.Patches {
		patchDocs, err := LoadFile(filepath.Join(dir, patch.Path))
		if err != nil {
			return nil, fmt.Errorf("patch %s: %w", patch.Path, err)
		}
		for _, p := range patchDocs {
			docs = ApplyPatch(docs, p, patch.Target.Kind, patch.Target.Name)
		}
	}

	return docs, nil
}

func LoadFile(path string) ([]Resource, error) {
	if path == "-" {
		return ParseManifests(os.Stdin)
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return LoadDir(path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseManifests(f)
}

func LoadDir(dir string) ([]Resource, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var all []Resource
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".yaml") && !strings.HasSuffix(name, ".yml") {
			continue
		}
		if name == "kustomization.yaml" || name == "kustomization.yml" {
			continue
		}
		docs, err := LoadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		all = append(all, docs...)
	}
	return all, nil
}

func ParseManifests(r io.Reader) ([]Resource, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	var docs []Resource
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var doc Resource
		if err := dec.Decode(&doc); err != nil {
			if err == io.EOF {
				break
			}
			return nil, fmt.Errorf("parse YAML: %w", err)
		}
		if doc.Kind == "" {
			continue
		}
		docs = append(docs, doc)
	}
	return docs, nil
}

func MergeResources(docs, incoming []Resource) []Resource {
	idx := make(map[string]int, len(docs))
	for i, d := range docs {
		idx[ResourceKey(d)] = i
	}
	for _, inc := range incoming {
		key := ResourceKey(inc)
		if i, exists := idx[key]; exists {
			docs[i] = inc
		} else {
			idx[key] = len(docs)
			docs = append(docs, inc)
		}
	}
	return docs
}

func ResourceKey(r Resource) string {
	return strings.ToLower(r.Kind) + "/" + r.Name
}

func ApplyPatch(docs []Resource, patch Resource, targetKind, targetName string) []Resource {
	for i := range docs {
		if !matchesTarget(docs[i], targetKind, targetName) {
			continue
		}
		docs[i] = StrategicMerge(docs[i], patch)
	}
	return docs
}

func matchesTarget(doc Resource, kind, name string) bool {
	if kind != "" && !strings.EqualFold(doc.Kind, kind) {
		return false
	}
	if name != "" && doc.Name != name {
		return false
	}
	return true
}

func StrategicMerge(base, patch Resource) Resource {
	if patch.Name != "" {
		base.Name = patch.Name
	}
	if patch.Description != "" {
		base.Description = patch.Description
	}
	if patch.Prompt != "" {
		base.Prompt = patch.Prompt
	}
	if patch.Provider != "" {
		base.Provider = patch.Provider
	}
	if patch.Token != "" {
		base.Token = patch.Token
	}
	if patch.URL != "" {
		base.URL = patch.URL
	}
	if patch.Email != "" {
		base.Email = patch.Email
	}
	if len(patch.Payloads) > 0 {
		base.Payloads = patch.Payloads
	}
	if patch.Image != "" {
		base.Image = patch.Image
	}
	if patch.Config != "" {
		base.Config = patch.Config
	}
	if len(patch.ServerDnsNames) > 0 {
		base.ServerDnsNames = patch.ServerDnsNames
	}
	if len(patch.Oidc) > 0 {
		base.Oidc = patch.Oidc
	}
	if patch.SandboxPolicy != "" {
		base.SandboxPolicy = patch.SandboxPolicy
	}
	for k, v := range patch.Spec {
		if base.Spec == nil {
			base.Spec = make(map[string]any)
		}
		base.Spec[k] = v
	}
	for k, v := range patch.Environment {
		if base.Environment == nil {
			base.Environment = make(map[string]string)
		}
		base.Environment[k] = v
	}
	for k, v := range patch.Labels {
		if base.Labels == nil {
			base.Labels = make(map[string]string)
		}
		base.Labels[k] = v
	}
	for k, v := range patch.Annotations {
		if base.Annotations == nil {
			base.Annotations = make(map[string]string)
		}
		base.Annotations[k] = v
	}
	return base
}
