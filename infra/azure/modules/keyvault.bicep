@description('Key Vault holding session secret, LTI signing keys, resolver credentials, DB URL, card-fingerprint key, App Insights connection string (spec §35.4). NO secret VALUES live in IaC — they are seeded out of band.')
param name string
param location string
param tags object = {}
param tenantId string = subscription().tenantId
@description('Principal ID of the managed identity that needs Key Vault Secrets User.')
#disable-next-line secure-secrets-in-params
param secretsReaderPrincipalId string
@description('Optional additional principal (e.g. the deploy identity) that needs Secrets User for the migrate job.')
param deployPrincipalId string = ''

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

var secretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, secretsReaderPrincipalId, 'KeyVaultSecretsUser')
  scope: kv
  properties: {
    principalId: secretsReaderPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleId
  }
}

resource deployAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  name: guid(kv.id, deployPrincipalId, 'KeyVaultSecretsUser')
  scope: kv
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleId
  }
}

output name string = kv.name
output uri string = kv.properties.vaultUri
