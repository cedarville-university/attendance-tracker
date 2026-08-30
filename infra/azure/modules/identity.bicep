@description('User-assigned managed identity for this environment. Used by Container Apps to pull from ACR and read Key Vault, and by the GitHub OIDC federated credential.')
param name string
param location string
param tags object = {}

resource mi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = mi.id
output principalId string = mi.properties.principalId
output clientId string = mi.properties.clientId
output name string = mi.name
