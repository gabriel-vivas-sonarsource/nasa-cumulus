locals {
  lambda_path         = "${path.module}/dist/webpack/lambda.zip"
  all_bucket_names    = [for k, v in var.buckets : v.name]
}
resource "aws_lambda_function" "postgres_migration_count_tool" {
  function_name    = "${var.prefix}-postgres-migration-count-tool"
  filename         = local.lambda_path
  source_code_hash = filebase64sha256(local.lambda_path)
  handler          = "index.handler"
  role             = aws_iam_role.postgres_migration_count_role.arn
  runtime          = "nodejs12.x"
  timeout          = 900
  memory_size      = 1024

  environment {
    variables = {
      AsyncOperationsTable        = var.dynamo_tables.async_operations.name
      CollectionsTable            = var.dynamo_tables.collections.name
      databaseCredentialSecretArn = var.rds_user_access_secret_arn
      dbHeartBeat                 = var.rds_connection_heartbeat
      dbRetryFailedConnection     = var.db_retry_failed_connection
      dbRetryConfigMaxTimeout     = lookup(var.db_retry_configuration, "max_timeout", "")
      dbRetryConfigMinTimeout     = lookup(var.db_retry_configuration, "min_timeout", "")
      dbRetryConfigFactor         = lookup(var.db_retry_configuration, "factor", "")
      dbRetryConfigRetries        = lookup(var.db_retry_configuration, "retries", "")
      ExecutionsTable             = var.dynamo_tables.executions.name
      ExecutionsTable             = var.dynamo_tables.executions.name
      GranulesTable               = var.dynamo_tables.granules.name
      GranulesTable               = var.dynamo_tables.granules.name
      PdrsTable                   = var.dynamo_tables.pdrs.name
      PdrsTable                   = var.dynamo_tables.pdrs.name
      prefix                      = var.prefix
      ProvidersTable              = var.dynamo_tables.providers.name
      RulesTable                  = var.dynamo_tables.rules.name
      systemBucket                = var.system_bucket
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = compact([
        aws_security_group.postgres_migration_count[0].id,
        var.rds_security_group_id
      ])
    }
  }

  tags = var.tags
}
