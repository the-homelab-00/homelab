#!/usr/bin/env bash
set -o errexit
set -o pipefail

KUBERNETES_DIR=$1

# Check if Kubernetes directory is specified
if [[ -z "${KUBERNETES_DIR}" ]]; then
  echo "Kubernetes location not specified"
  exit 1
fi

kustomize_args=("--load-restrictor=LoadRestrictionsNone")
kustomize_config="kustomization.yaml"
kubeconform_args=(
  "-strict"
  "-ignore-missing-schemas"
  "-skip"
  "Secret,ReplicationDestination,ReplicationSource"
  "-schema-location"
  "default"
  "-schema-location"
  "https://kubernetes-schemas.pages.dev/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
  "-verbose"
)

# Function to validate YAML files
validate_yaml_files() {
  local dir="$1"
  echo "=== Validating standalone manifests in ${dir} ==="

  find "${dir}" -maxdepth 1 -type f -name '*.yaml' -print0 | while IFS= read -r -d '' file; do
    echo "Validating file: ${file}"
    if kubeconform "${kubeconform_args[@]}" "${file}"; then
      echo "Validation successful for ${file}"
    else
      echo "Validation failed for ${file}"
      exit 1
    fi
  done
}

# Function to validate Kustomization files
validate_kustomizations() {
  local dir="$1"
  echo "=== Validating kustomizations in ${dir} ==="

  find "${dir}" -type f -name "${kustomize_config}" -print0 | while IFS= read -r -d '' file; do
    echo "=== Validating kustomizations in ${file/%$kustomize_config} ==="
    echo "Building kustomization from ${file/%$kustomize_config}"

    if kustomize build "${file/%$kustomize_config}" "${kustomize_args[@]}" | kubeconform "${kubeconform_args[@]}"; then
      echo "Validation successful for kustomization in ${file/%$kustomize_config}"
    else
      echo "Validation failed for kustomization in ${file/%$kustomize_config}"
      exit 1
    fi
  done
}

# Validate standalone manifests and Kustomizations in flux and apps directories
validate_yaml_files "${KUBERNETES_DIR}/flux"
validate_kustomizations "${KUBERNETES_DIR}/flux"
validate_kustomizations "${KUBERNETES_DIR}/apps"
