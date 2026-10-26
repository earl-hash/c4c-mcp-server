{{- define "c4c-mcp.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "c4c-mcp.fullname" -}}{{ printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "c4c-mcp.labels" -}}
app.kubernetes.io/name: {{ include "c4c-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "c4c-mcp.selector" -}}
app.kubernetes.io/name: {{ include "c4c-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "c4c-mcp.serviceAccountName" -}}{{ default (include "c4c-mcp.fullname" .) .Values.serviceAccount.name }}{{- end -}}
