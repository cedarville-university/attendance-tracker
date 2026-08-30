@description('attendance-web Container App (spec §35.1). Same image runs static frontend + API + LTI + JWKS + health. One warm replica in prod.')
param name string
param location string
param tags object = {}
param environmentId string
param image string
param managedIdentityId string
param managedIdentityClientId string
param acrLoginServer string
param keyVaultUri string
param appBaseUrl string
param allowedTargetLinkUris string
param cpu string
param memory string
param minReplicas int
param maxReplicas int
@description('Identity API base URL for the real ProxID resolver (decision #3). Non-secret.')
param identityApiUrl string
param identityApiKeyName string

var kvRef = '${keyVaultUri}secrets/'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
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
          name: 'web'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          command: ['node', 'server/dist/index.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
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
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Startup', httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 5, failureThreshold: 30 }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output name string = app.name
