@description('Azure Container Registry. Images are tagged with the git SHA; `latest` is never deployed (spec §35.5).')
param name string
param location string
param tags object = {}
@allowed(['Basic', 'Standard', 'Premium'])
param sku string = 'Standard'
@description('Principal ID of the managed identity that needs AcrPull.')
param pullPrincipalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

// AcrPull for the managed identity (role definition id is well-known and constant).
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, pullPrincipalId, 'AcrPull')
  scope: acr
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

output loginServer string = acr.properties.loginServer
output name string = acr.name
