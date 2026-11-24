{{- define "pagehouse.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "pagehouse.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "pagehouse.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Name of the Secret that holds the database password and URL. */}}
{{- define "pagehouse.secret" -}}{{ include "pagehouse.fullname" . }}-db{{- end -}}

{{/* The database password: reused from the existing Secret on upgrades, so it never changes under a running database. */}}
{{- define "pagehouse.dbPassword" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "pagehouse.secret" .) -}}
{{- if and $existing $existing.data $existing.data.password -}}{{ $existing.data.password | b64dec }}{{- else -}}{{ randAlphaNum 32 }}{{- end -}}
{{- end -}}

{{- define "pagehouse.dbHost" -}}{{ include "pagehouse.fullname" . }}-postgresql{{- end -}}
