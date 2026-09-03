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
@description('Bare public hostname for the Container App custom domain, e.g. attendance-dev.cedarville.edu. Empty or a CHANGEME placeholder disables the binding.')
param appHostname string = ''
@description('none | hostname | bound — how far to take the custom domain. See main.bicep for why this is a ladder rather than a boolean.')
@allowed(['none', 'hostname', 'bound'])
param customDomainMode string = 'bound'
@description('When true, wire SETUP_TOKEN from the `setup-token` Key Vault secret (admin/setup page bootstrap). The secret MUST be seeded in the vault first or the deploy fails to resolve it. Enable in dev only; leave off for stage/prod.')
param setupTokenEnabled bool = false

var kvRef = '${keyVaultUri}secrets/'

// A placeholder or empty hostname is never registered, whatever the mode asks for.
var hostnameIsReal = !empty(appHostname) && !contains(toLower(appHostname), 'changeme')
// Registering the hostname (binding disabled) is what makes the certificate request
// legal: Azure answers RequireCustomHostnameInEnvironment otherwise. So `bound`
// implies `hostname`, and the two cannot be applied in a single deployment.
var registerHostname = hostnameIsReal && customDomainMode != 'none'
var bindCertificate = hostnameIsReal && customDomainMode == 'bound'

var environmentName = last(split(environmentId, '/'))

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource webCert 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (bindCertificate) {
  parent: managedEnv
  name: 'cert-${replace(appHostname, '.', '-')}'
  location: location
  properties: {
    subjectName: appHostname
    domainControlValidation: 'CNAME'
  }
}

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
        customDomains: registerHostname ? [
          bindCertificate ? {
            name: appHostname
            bindingType: 'SniEnabled'
            certificateId: webCert.id
          } : {
            name: appHostname
            bindingType: 'Disabled'
          }
        ] : null
      }
      registries: [
        { server: acrLoginServer, identity: managedIdentityId }
      ]
      secrets: concat([
        { name: 'database-url', keyVaultUrl: '${kvRef}database-url', identity: managedIdentityId }
        { name: 'lti-tool-signing-keys-json', keyVaultUrl: '${kvRef}lti-tool-signing-keys-json', identity: managedIdentityId }
        { name: 'card-fingerprint-secret', keyVaultUrl: '${kvRef}card-fingerprint-secret', identity: managedIdentityId }
        { name: 'identity-api-key', keyVaultUrl: '${kvRef}identity-api-key', identity: managedIdentityId }
        { name: 'appinsights-connection-string', keyVaultUrl: '${kvRef}appinsights-connection-string', identity: managedIdentityId }
      ], setupTokenEnabled ? [
        { name: 'setup-token', keyVaultUrl: '${kvRef}setup-token', identity: managedIdentityId }
      ] : [])
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          command: ['node', '--import', './server/dist/telemetry/otel-preload.js', 'server/dist/index.js']
          env: concat([
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
          ], setupTokenEnabled ? [
            { name: 'SETUP_TOKEN', secretRef: 'setup-token' }
          ] : [])
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
output customDomainVerificationId string = app.properties.customDomainVerificationId
