# @plur-ai/gateway — internal

**Not published.** This package is `private: true`. It is bundled into
`@plur-ai/cli` and `@plur-ai/mcp` at build time (`noExternal:
['@plur-ai/gateway']`), the same way `@plur-ai/ui` is.

It is PLUR's only network client for provenance: plain HTTP calls to the
provenance gateway's API (upload a session manifest, download one, read the
gateway's notary address). The gateway stores on Swarm and signs; PLUR carries
no Swarm or Bee client and depends on none. The gateway address is a user
setting (`receipts.gateway_url` in `config.yaml`); `DEFAULT_GATEWAY_URL` is the
default we ship.

It lives outside `@plur-ai/core` because core makes no provenance network calls
(`packages/core/test/no-gateway-network-in-core.test.ts`).
