@description('Azure Database for PostgreSQL Flexible Server (spec §35.3). TLS required; PITR via backup retention. Public network access ON so the CI migrate job can connect through a just-in-time firewall rule (spec §39 / decision #8); tightening to a private path is a Phase 8 item.')
param name string
param location string
param tags object = {}
param skuName string
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string
param storageGb int
param backupRetentionDays int
param geoRedundantBackup bool
param administratorLogin string
@secure()
param administratorPassword string
param databaseName string = 'attendance'
@description('Entra admin object id (optional). Empty = password auth only.')
param aadAdminObjectId string = ''
param aadAdminPrincipalName string = ''

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: { storageSizeGB: storageGb, autoGrow: 'Enabled' }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: {
      activeDirectoryAuth: empty(aadAdminObjectId) ? 'Disabled' : 'Enabled'
      passwordAuth: 'Enabled'
    }
  }
}

// require_secure_transport is ON by default on Flexible Server; pin it explicitly.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Allow other Azure services (Container Apps egress) to reach the server. The CI migrate job adds
// and removes its own runner-IP rule at deploy time.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource aadAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(aadAdminObjectId)) {
  parent: pg
  name: aadAdminObjectId
  properties: {
    principalType: 'Group'
    principalName: aadAdminPrincipalName
    tenantId: subscription().tenantId
  }
}

output fqdn string = pg.properties.fullyQualifiedDomainName
output name string = pg.name
output databaseName string = databaseName
