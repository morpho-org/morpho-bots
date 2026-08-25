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

{{/*
Immutable selector labels shared by the StatefulSet selector and pod template. Deliberately
derived from .Chart.Name and the release name — never nameOverride — because
.spec.selector.matchLabels is immutable: an override change on an installed release would
otherwise patch the pod template labels while the resource name stays put and the upgrade
would be rejected.
*/}}
{{- define "quoter-bot.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end }}

{{/* Name of the ServiceAccount the pod runs as. */}}
{{- define "quoter-bot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "quoter-bot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolved image reference; the tag falls back to the chart appVersion. toString keeps
numeric-looking repositories or tags (for example an all-digit commit tag) from reaching
printf as parsed YAML numbers.
*/}}
{{- define "quoter-bot.image" -}}
{{- printf "%s:%s" (.Values.image.repository | toString) (default .Chart.AppVersion .Values.image.tag | toString) }}
{{- end }}

{{/*
State-claim name, bounded to the 63-character DNS label limit: the base is truncated so the
"-state" suffix always fits, keeping valid long release names installable.
*/}}
{{- define "quoter-bot.stateClaimName" -}}
{{- printf "%s-state" (include "quoter-bot.fullname" . | trunc 57 | trimSuffix "-") }}
{{- end }}

{{/*
Name of the release-name-keyed ConfigMap pinning the installed fullname. Bounded to the
63-character DNS label limit: the release name is truncated so the suffix always fits (releases
sharing the first 43 characters within one namespace would share this pin, which the guard
tolerates only when their fullnames also match).
*/}}
{{- define "quoter-bot.releaseFullnameConfigMapName" -}}
{{- printf "%s-quoter-bot-fullname" (.Release.Name | trunc 43 | trimSuffix "-") }}
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
{{- printf "%s-config" (include "quoter-bot.fullname" . | trunc 56 | trimSuffix "-") }}
{{- end }}
{{- end }}

{{/* The rendered configuration file content, copied verbatim from .Values.config. */}}
{{- define "quoter-bot.configYaml" -}}
{{- toYaml .Values.config }}
{{- end }}
