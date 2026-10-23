{{- define "midnight-liquidation.name" -}}
{{- .Chart.Name }}
{{- end }}

{{- define "midnight-liquidation.fullname" -}}
{{- $name := .Chart.Name }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "midnight-liquidation.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "midnight-liquidation.labels" -}}
helm.sh/chart: {{ include "midnight-liquidation.chart" . }}
{{ include "midnight-liquidation.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "midnight-liquidation.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end }}

{{- define "midnight-liquidation.serviceAccountName" -}}
{{- required "serviceAccount.name is required" .Values.serviceAccount.name }}
{{- end }}

{{- define "midnight-liquidation.runtimeSecretName" -}}
{{- $fullname := include "midnight-liquidation.fullname" . }}
{{- if gt (len $fullname) 55 }}
{{- printf "%s-%s-runtime" ($fullname | trunc 46 | trimSuffix "-") (sha256sum $fullname | trunc 8) }}
{{- else }}
{{- printf "%s-runtime" $fullname }}
{{- end }}
{{- end }}

{{- define "midnight-liquidation.secretStoreName" -}}
{{- $fullname := include "midnight-liquidation.fullname" . }}
{{- if gt (len $fullname) 59 }}
{{- printf "%s-%s-aws" ($fullname | trunc 50 | trimSuffix "-") (sha256sum $fullname | trunc 8) }}
{{- else }}
{{- printf "%s-aws" $fullname }}
{{- end }}
{{- end }}

{{- define "midnight-liquidation.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository | toString -}}
{{- $tag := required "image.tag is required" .Values.image.tag | toString -}}
{{- printf "%s:%s" $repository $tag }}
{{- end }}
