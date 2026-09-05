// The in-cluster API's source is pkg/dev-extension/dev-api/server.mjs, a real file with a real
// syntax check; scripts/gen-dev-api.mjs packs it into the string the ConfigMap needs. This
// module keeps the name api.ts has always imported.
export { DEV_API_SERVER as WORKSPACE_API_SERVER } from './dev-api.generated';
