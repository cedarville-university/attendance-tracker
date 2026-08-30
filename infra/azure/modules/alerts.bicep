@description('Azure Monitor action group + alert rules (spec §44). Thresholds are conservative defaults, tuned in Phase 8.')
param namePrefix string
param location string = 'global'
param tags object = {}
param alertEmail string
param appInsightsId string
param postgresResourceId string
@description('Reserved for a Phase 8 log-query alert scoped to the web Container App revision.')
#disable-next-line no-unused-params
param webContainerAppId string

resource ag 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-ag'
  location: location
  tags: tags
  properties: {
    groupShortName: take(namePrefix, 12)
    enabled: true
    emailReceivers: [
      { name: 'ops', emailAddress: alertEmail, useCommonAlertSchema: true }
    ]
  }
}

// Elevated 5xx rate (App Insights requests failed).
resource fivexx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-5xx'
  location: 'global'
  tags: tags
  properties: {
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failedRequests'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'requests/failed'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// Database unavailable (Postgres up-time / connections).
resource dbDown 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-db-down'
  location: 'global'
  tags: tags
  properties: {
    severity: 1
    enabled: true
    scopes: [postgresResourceId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'connectionsFailed'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'connections_failed'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// Sustained LTI launch failures / card-resolver failures / grade-job failures + Key Vault access
// failure are custom-metric or log-query alerts. Provision them as scheduledQueryRules over the
// App Insights customMetrics / traces emitted by server/src/telemetry/metrics.ts. One example:
resource launchFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${namePrefix}-lti-launch-failures'
  location: location == 'global' ? resourceGroup().location : location
  tags: tags
  kind: 'LogAlert'
  properties: {
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'customMetrics | where name == "lti.launch" | extend result = tostring(customDimensions.result) | where result == "failure" | summarize failures = sum(value) | where failures > 10'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ag.id] }
  }
}

output actionGroupId string = ag.id
