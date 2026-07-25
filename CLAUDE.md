# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A GitOps homelab: a single-node **Talos Linux** Kubernetes cluster (`home-lab-1` @ `10.0.0.10`, VIP `10.0.0.55`) reconciled by **Flux**. It started as [onedr0p/cluster-template](https://github.com/onedr0p/cluster-template) and the template machinery (`templates/`, `makejinja.toml`, `cluster.yaml`, `nodes.yaml`) is still present and *not* tidied away, so parts of the repo are generated and parts are hand-written divergence from upstream. `README.md` is still the upstream template README — it describes the bootstrap flow accurately but knows nothing about the apps actually running here.

Everything is YAML/shell/Jinja — there is no application source code, no build, and no test suite. "Testing" means rendering and schema-validating manifests.

## Toolchain

All CLIs are pinned in `.mise.toml` (talhelper, talosctl, flux, helmfile, kustomize, kubeconform, sops, cilium, cloudflared, cue, task…). Run `mise install` first; every command below assumes mise-activated PATH.

`.mise.toml` and `Taskfile.yaml` both export:
- `KUBECONFIG=./kubeconfig`
- `TALOSCONFIG=./talos/clusterconfig/talosconfig`
- `SOPS_AGE_KEY_FILE=./age.key`

## Commands

```sh
task                          # list tasks
task init                     # generate age.key, github deploy key, push token (idempotent)
task configure                # cue-validate cluster.yaml/nodes.yaml -> makejinja render -> sops-encrypt -> kubeconform -> talhelper validate
task template:debug           # kubectl get certs/gitrepos/helmreleases/httproutes/ks/nodes/pods -A
task reconcile                # flux reconcile kustomization flux-system --with-source

task bootstrap:talos          # gensecret + genconfig + apply + bootstrap + fetch kubeconfig
task bootstrap:apps           # scripts/bootstrap-apps.sh (see caveat below)

task talos:generate-config    # talhelper genconfig -> talos/clusterconfig/
task talos:apply-node IP=10.0.0.10 MODE=auto
task talos:upgrade-node IP=10.0.0.10       # version comes from talos/talenv.yaml
task talos:upgrade-k8s
task talos:reset              # destructive, prompts
```

Validation/rendering, the closest thing to a test loop:

```sh
task configure                                        # full render + validate (overwrites kubernetes/ from templates!)
bash .taskfiles/template/resources/kubeconform.sh kubernetes   # validate only
kustomize build kubernetes/apps/default/frigate/app --load-restrictor=LoadRestrictionsNone
flux-local test --enable-helm --all-namespaces --path kubernetes/flux/cluster   # what CI runs
```

CI (`.github/workflows/flux-local.yaml`) runs `flux-local test` plus a `helmrelease`/`kustomization` diff against `main` on any PR touching `kubernetes/**`. Renovate (`.renovaterc.json5` + `.github/renovate/`) opens the dependency PRs; it ignores `**/*.sops.*`.

> `task configure` re-renders from `templates/` over `kubernetes/`, `talos/` and `bootstrap/`. Hand-written apps (anything not present under `templates/config/`) survive, but files that *do* have a `.j2` counterpart get overwritten. Prefer editing manifests directly and only run `configure` when intentionally re-templating.

## Flux delivery chain

Understanding this chain is the key to the repo — an app is deployed only if every link exists:

1. `flux-instance` HelmRelease points Flux at `github.com/the-homelab-00/homelab`, path `kubernetes/flux/cluster`.
2. `kubernetes/flux/cluster/ks.yaml` — the `cluster-apps` Kustomization, `path: ./kubernetes/apps`. It carries a **patch-of-a-patch**: every child Kustomization inherits `decryption.provider: sops` + `deletionPolicy: WaitForTermination`, and every HelmRelease inside them inherits install/upgrade/rollback remediation defaults. Don't repeat those per app.
3. `kubernetes/apps/<namespace>/kustomization.yaml` — plain Kustomize; lists `./namespace.yaml`, the `../../components/sops` component (injects the `cluster-secrets` Secret), and one `./<app>/ks.yaml` per app.
4. `kubernetes/apps/<namespace>/<app>/ks.yaml` — Flux Kustomization: `path: ./kubernetes/apps/<ns>/<app>/app`, `dependsOn`, `postBuild.substitute` vars.
5. `kubernetes/apps/<namespace>/<app>/app/` — `kustomization.yaml` + `helmrelease.yaml` + `ocirepository.yaml` + `externalsecret.yaml` + `pvc.yaml` + optional `resources/`.

**Most app directories in this repo are not wired into step 3** (all of `default/` except `echo`, plus spegel, snapshot-controller, node-feature-discovery, intel-device-plugin, kubelet-csr-approver, multus, unifi-dns, blocky, external-dns, capacitor, webhooks, cloudnative-pg, grafana, kube-prometheus-stack). Several were removed from the namespace kustomizations in the *uncommitted* working tree — the cluster is mid-rebuild. Before assuming an app is live, check its namespace `kustomization.yaml`, and when re-enabling one also re-enable everything its `dependsOn` names.

## Conventions when adding/changing an app

- Charts come from OCI: an `OCIRepository` (usually `oci://ghcr.io/bjw-s-labs/helm/app-template`) referenced by `spec.chartRef` in the HelmRelease. Most workloads are bjw-s `app-template` (`controllers` / `service` / `route` / `persistence` keys).
- Ingress is **Gateway API**, not Ingress: `route:` with `parentRefs` to `envoy-internal` (LAN-only) or `envoy-external` (public via cloudflared) in namespace `network`. `kubernetes/apps/network/ingress-nginx/` is dead legacy — don't add to it.
- Variables like `${SECRET_DOMAIN}` come from the sops-encrypted `cluster-secrets` Secret via `postBuild.substituteFrom`; `${APP}`, `${VOLSYNC_*}`, `${GATUS_*}` come from `postBuild.substitute` in the app's `ks.yaml`.
- Reusable manifests live in `kubernetes/templates/{volsync,gatus}` and are pulled in as relative resources (`../../../../templates/volsync`) from an app's `app/kustomization.yaml`, parameterized entirely through those substitution vars.
- Storage: `topolvm-thin-provisioner` (LVM thin pool on the node) for app data, `openebs-hostpath` for caches. Backups are VolSync/restic to the in-cluster MinIO.
- Keep the `# yaml-language-server: $schema=` header lines; kubeconform and editors rely on them.

## Secrets

Two distinct mechanisms:

- **SOPS + age** for anything Flux needs before ESO exists: `*.sops.yaml` files under `bootstrap/`, `kubernetes/`, `talos/`. Rules in `.sops.yaml` (talos files encrypt whole-file; kubernetes/bootstrap encrypt only `data|stringData`). kustomize-controller decrypts in-cluster via the `sops-age` Secret. `task configure` auto-encrypts any plaintext `*.sops.*` it finds.
- **External Secrets + 1Password** for application secrets: `ExternalSecret` → `ClusterSecretStore` named `onepassword` (`kubernetes/apps/external-secrets/`). Apps that use it must `dependsOn` `onepassword` in `external-secrets`.

Plaintext credentials live untracked in the working directory and are gitignored: `age.key`, `cluster.yaml` (contains a live Cloudflare API token), `nodes.yaml`, `config.yaml`, `kubeconfig`, `talosconfig`, `cloudflare-tunnel.json`, `github-deploy.key`, `github-push-token.txt`, `secrets.yaml`, `talos/talsecret.sops.yaml`. Never cat, echo, or commit these; when a task needs them, reference the path.

## Talos layout gotchas

- **Live config is `talos/`**: `talconfig.yaml` (talhelper), `talenv.yaml` (Talos/Kubernetes versions, Renovate-managed), `patches/global/*`, `patches/controller/*`, rendered output in `talos/clusterconfig/` (gitignored).
- `kubernetes/bootstrap/talos/` is **stale layout from an older template revision** — same idea, different patches, not used by any Taskfile. Don't edit it expecting an effect.
- Similarly `bootstrap/helmfile.d/` (root) is the live bootstrap chart set — CRDs in `00-crds.yaml`, then cilium → coredns → cert-manager → flux-operator → flux-instance in `01-apps.yaml`. `kubernetes/bootstrap/helmfile.yaml` is legacy.
- `scripts/bootstrap-apps.sh` currently has `wait_for_nodes`, `apply_namespaces`, `apply_crds` and `sync_helm_releases` **commented out** in `main()` — only SOPS secrets get applied. A real bootstrap needs those uncommented.
- Node specifics baked into `talos/talconfig.yaml`: `bond0` over `enp42s0`, VLAN 2 (`10.0.1.5/24`) for IoT, NVIDIA + `dm_thin_pool`/`dm_mod` kernel modules, install disk `/dev/sda`, CNI disabled (Cilium takes over). System extensions are listed in `extensions`.

## Cluster facts worth knowing

- Networks: nodes `10.0.0.0/24`, pods `10.69.0.0/16`, services `10.96.0.0/16`. Cilium in kube-proxy-free mode with BGP (`10.0.0.1`, ASN 64513/64514) and L2 announcements; gateway LB IPs `10.0.0.61` internal, `10.0.0.62` k8s-gateway DNS, `10.0.0.63` external.
- Public entry is Cloudflare Tunnel + `external-dns`/`cloudflare-dns`; internal name resolution is `k8s-gateway` (split DNS), with `unifi-dns` and `blocky` present but unwired.
- `multus` provides a macvlan `iot` network on VLAN 2; pods that need it (e.g. home-assistant, zigbee2mqtt) request it via the `k8s.v1.cni.cncf.io/networks` pod annotation with a static IP.
- Domain is `${SECRET_DOMAIN}` (sops-encrypted). `origin` is `the-homelab-00/homelab`; `upstream` is `onedr0p/cluster-template`, so `git log upstream/main` is useful for seeing what template changes have not been merged.
