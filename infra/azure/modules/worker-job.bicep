@description('attendance-grade-worker (spec §35.2) as a schedule-triggered Container Apps Job. Same image as web, command node --import ./server/dist/telemetry/otel-preload.js server/dist/worker.js, every 5 minutes, one replica, scale-to-zero between runs.')
param name string
param location string
param tags object = {}
param environmentId string
param image string
param managedIdentityId string
param managedIdentityClientId string
param acrLoginServer string
param keyVaultUri string
param identityApiUrl string
param identityApiKeyName string
@description('Non-secret. server/src/config/env.ts loadEnv() (called by worker.ts) requires APP_BASE_URL and ALLOWED_TARGET_LINK_URIS or the worker throws on boot.')
param appBaseUrl string
param allowedTargetLinkUris string
param cpu string
param memory string

var kvRef = '${keyVaultUri}secrets/'

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        { server: acrLoginServer, identity: managedIdentityId }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${kvRef}database-url', identity: managedIdentityId }
        { name: 'lti-tool-signing-keys-json', keyVaultUrl: '${kvRef}lti-tool-signing-keys-json', identity: managedIdentityId }
        { name: 'card-fingerprint-secret', keyVaultUrl: '${kvRef}card-fingerprint-secret', identity: managedIdentityId }
        { name: 'identity-api-key', keyVaultUrl: '${kvRef}identity-api-key', identity: managedIdentityId }
        { name: 'appinsights-connection-string', keyVaultUrl: '${kvRef}appinsights-connection-string', identity: managedIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'grade-worker'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          command: ['node', '--import', './server/dist/telemetry/otel-preload.js', 'server/dist/worker.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'RUN_MIGRATIONS_ON_BOOT', value: 'false' }
            { name: 'APP_BASE_URL', value: appBaseUrl }
            { name: 'ALLOWED_TARGET_LINK_URIS', value: allowedTargetLinkUris }
            { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
            { name: 'IDENTITY_API_URL', value: identityApiUrl }
            { name: 'IDENTITY_API_KEY_NAME', value: identityApiKeyName }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'LTI_TOOL_SIGNING_KEYS_JSON', secretRef: 'lti-tool-signing-keys-json' }
            { name: 'CARD_FINGERPRINT_SECRET', secretRef: 'card-fingerprint-secret' }
            { name: 'IDENTITY_API_KEY', secretRef: 'identity-api-key' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
          ]
        }
      ]
    }
  }
}

output name string = job.name
