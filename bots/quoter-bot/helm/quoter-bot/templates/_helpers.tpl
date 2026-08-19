{{/* Chart name, overridable per release. */}}
{{- define "quoter-bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified resource name, truncated to the 63-character DNS label limit. */}}
{{- define "quoter-bot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Chart-and-version label value. */}}
{{- define "quoter-bot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels applied to every rendered resource. */}}
{{- define "quoter-bot.labels" -}}
helm.sh/chart: {{ include "quoter-bot.chart" . }}
{{ include "quoter-bot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Immutable selector labels shared by the Deployment selector and pod template. */}}
{{- define "quoter-bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "quoter-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Resolved image reference; the tag falls back to the chart appVersion. */}}
{{- define "quoter-bot.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Whether any configuration file is mounted and passed through --config. */}}
{{- define "quoter-bot.hasConfigFile" -}}
{{- if or .Values.existingConfigSecret .Values.config }}true{{ end }}
{{- end }}

{{/* Name of the Secret providing the quoter-bot.yaml configuration file. */}}
{{- define "quoter-bot.configSecretName" -}}
{{- if .Values.existingConfigSecret }}
{{- .Values.existingConfigSecret }}
{{- else }}
{{- printf "%s-config" (include "quoter-bot.fullname" .) }}
{{- end }}
{{- end }}

{{/* The rendered configuration file content, copied verbatim from .Values.config. */}}
{{- define "quoter-bot.configYaml" -}}
{{- toYaml .Values.config }}
{{- end }}
