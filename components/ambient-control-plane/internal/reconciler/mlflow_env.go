package reconciler

var mlflowRuntimeEnvOrder = []string{
	"MLFLOW_TRACING_ENABLED",
	"MLFLOW_TRACKING_URI",
	"MLFLOW_EXPERIMENT_NAME",
	"MLFLOW_TRACKING_AUTH",
	"MLFLOW_WORKSPACE",
	"MLFLOW_ENABLE_ASYNC_TRACE_LOGGING",
	"MLFLOW_ASYNC_TRACE_LOGGING_MAX_WORKERS",
	"MLFLOW_ASYNC_TRACE_LOGGING_MAX_QUEUE_SIZE",
	"MLFLOW_AUTOLOG_EXCLUDE_FLAVORS",
	"MLFLOW_GENAI_AUTOLOG_INTEGRATIONS",
}

func (r *SimpleKubeReconciler) mlflowRuntimeEnv() map[string]string {
	if r.cfg.MLflowTrackingURI == "" {
		return map[string]string{}
	}

	env := map[string]string{
		"MLFLOW_TRACING_ENABLED":            defaultString(r.cfg.MLflowTracingEnabled, "true"),
		"MLFLOW_TRACKING_URI":               r.cfg.MLflowTrackingURI,
		"MLFLOW_ENABLE_ASYNC_TRACE_LOGGING": defaultString(r.cfg.MLflowEnableAsyncTraceLogging, "true"),
		"MLFLOW_GENAI_AUTOLOG_INTEGRATIONS": defaultString(r.cfg.MLflowGenAIAutologIntegrations, "anthropic,openai"),
	}
	putIfSet(env, "MLFLOW_EXPERIMENT_NAME", r.cfg.MLflowExperimentName)
	putIfSet(env, "MLFLOW_TRACKING_AUTH", r.cfg.MLflowTrackingAuth)
	putIfSet(env, "MLFLOW_WORKSPACE", r.cfg.MLflowWorkspace)
	putIfSet(env, "MLFLOW_ASYNC_TRACE_LOGGING_MAX_WORKERS", r.cfg.MLflowAsyncTraceLoggingWorkers)
	putIfSet(env, "MLFLOW_ASYNC_TRACE_LOGGING_MAX_QUEUE_SIZE", r.cfg.MLflowAsyncTraceLoggingQueue)
	putIfSet(env, "MLFLOW_AUTOLOG_EXCLUDE_FLAVORS", r.cfg.MLflowAutologExcludeFlavors)
	return env
}

func (r *SimpleKubeReconciler) applyMLflowRuntimeEnv(env map[string]string) {
	for name, value := range r.mlflowRuntimeEnv() {
		env[name] = value
	}
}

func (r *SimpleKubeReconciler) appendMLflowRuntimeEnv(env []interface{}) []interface{} {
	mlflowEnv := r.mlflowRuntimeEnv()
	for _, name := range mlflowRuntimeEnvOrder {
		if value, ok := mlflowEnv[name]; ok {
			env = append(env, envVar(name, value))
		}
	}
	return env
}

func defaultString(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func putIfSet(env map[string]string, name, value string) {
	if value != "" {
		env[name] = value
	}
}
