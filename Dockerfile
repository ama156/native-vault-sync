# syntax=docker/dockerfile:1
ARG GO_IMAGE=golang:1.27.4@sha256:205c7636d74e0ffbe3d007162df7d74f859f5a8c8322dfb9f907977686c126cf
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY server/cmd ./cmd
COPY server/internal ./internal
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOTOOLCHAIN=local \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o /out/vault-sync-server ./cmd/vault-sync-server
RUN install -d -m 0700 -o 10001 -g 10001 /runtime/etc/vault-sync /runtime/var/lib/vault-sync /runtime/backups
RUN install -d -m 1777 /runtime/tmp

FROM scratch AS runtime
LABEL org.opencontainers.image.title="Native Vault Sync server" \
      org.opencontainers.image.description="Personal native Sync compatible server; locally built image" \
      org.opencontainers.image.source="https://github.com/ama156/native-vault-sync" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /runtime/ /
COPY --from=build /out/vault-sync-server /usr/local/bin/vault-sync-server
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
USER 10001:10001
WORKDIR /var/lib/vault-sync
VOLUME ["/etc/vault-sync", "/var/lib/vault-sync"]
ENV VAULT_SYNC_LISTEN=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/vault-sync-server", "status"]
ENTRYPOINT ["/usr/local/bin/vault-sync-server"]
CMD ["serve"]
